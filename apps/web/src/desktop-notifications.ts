import {
  desktopNotificationDeliveryPageSchema,
  type DesktopNotificationDelivery,
} from '@nexa/api-contracts';
import { invoke, isTauri } from '@tauri-apps/api/core';

const preferencePrefix = 'nexa:desktop-notifications:v1:';
const pollIntervalMilliseconds = 30_000;
export const desktopNotificationPreferenceEvent =
  'nexa:desktop-notification-preference';

export type DesktopNotificationPermission =
  'granted' | 'denied' | 'prompt' | 'unavailable';

export interface DesktopNotificationStatus {
  supported: boolean;
  permission: DesktopNotificationPermission;
}

export type DesktopNotificationOutcome =
  | 'accepted'
  | 'duplicate'
  | 'permission_required'
  | 'rate_limited'
  | 'delivery_failed';

export interface DesktopNotificationResult {
  outcome: DesktopNotificationOutcome;
  route: '/notifications';
  retryAfterMilliseconds: number;
}

export interface DesktopNotificationPreference {
  version: 1;
  enabled: boolean;
  privacyMode: boolean;
  checkpoint: string | null;
}

export interface DesktopNotificationClient {
  status(): Promise<DesktopNotificationStatus>;
  requestPermission(): Promise<DesktopNotificationStatus>;
  deliver(
    delivery: DesktopNotificationDelivery,
    privacyMode: boolean,
  ): Promise<DesktopNotificationResult>;
}

type InvokeCommand = (
  command: string,
  argumentsValue?: Record<string, unknown>,
) => Promise<unknown>;

const defaultPreference: DesktopNotificationPreference = {
  version: 1,
  enabled: false,
  privacyMode: true,
  checkpoint: null,
};

export class DesktopNotificationError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unavailable'
      | 'invalid_response'
      | 'storage_unavailable',
  ) {
    super(code);
    this.name = 'DesktopNotificationError';
  }
}

export function createDesktopNotificationClient(
  invokeCommand: InvokeCommand = (command, argumentsValue) =>
    invoke<unknown>(command, argumentsValue),
  desktop = isTauri(),
): DesktopNotificationClient | undefined {
  if (!desktop) return undefined;

  const call = async (
    command: string,
    argumentsValue?: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      return await invokeCommand(command, argumentsValue);
    } catch (reason) {
      throw new DesktopNotificationError(
        reason === 'invalid_input' ? 'invalid_input' : 'unavailable',
      );
    }
  };

  return {
    async status() {
      const value = await call('desktop_notification_status');
      if (!isStatus(value))
        throw new DesktopNotificationError('invalid_response');
      return value;
    },
    async requestPermission() {
      const value = await call('request_desktop_notification_permission', {
        userInitiated: true,
      });
      if (!isStatus(value))
        throw new DesktopNotificationError('invalid_response');
      return value;
    },
    async deliver(delivery, privacyMode) {
      const value = await call('deliver_desktop_notification', {
        request: {
          notificationId: delivery.notificationId,
          kind: delivery.kind,
          version: delivery.version,
          route: delivery.route,
          privacyMode,
        },
      });
      if (!isDeliveryResult(value))
        throw new DesktopNotificationError('invalid_response');
      return value;
    },
  };
}

export function loadDesktopNotificationPreference(
  storage: Pick<Storage, 'getItem'>,
  accountId: string,
): DesktopNotificationPreference {
  try {
    const raw = storage.getItem(preferenceKey(accountId));
    if (!raw) return { ...defaultPreference };
    const value: unknown = JSON.parse(raw);
    return isPreference(value) ? value : { ...defaultPreference };
  } catch {
    return { ...defaultPreference };
  }
}

export function saveDesktopNotificationPreference(
  storage: Pick<Storage, 'setItem'>,
  accountId: string,
  preference: DesktopNotificationPreference,
): void {
  if (!isPreference(preference))
    throw new DesktopNotificationError('invalid_input');
  try {
    storage.setItem(preferenceKey(accountId), JSON.stringify(preference));
    if (typeof window !== 'undefined')
      window.dispatchEvent(new Event(desktopNotificationPreferenceEvent));
  } catch {
    throw new DesktopNotificationError('storage_unavailable');
  }
}

export async function initializeDesktopNotifications(input: {
  accountId: string;
  client: DesktopNotificationClient;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetcher?: typeof fetch;
}): Promise<DesktopNotificationPreference> {
  const page = await pollServer(
    input.accountId,
    null,
    true,
    input.fetcher ?? fetch,
  );
  const current = loadDesktopNotificationPreference(
    input.storage,
    input.accountId,
  );
  const next = {
    ...current,
    enabled: true,
    checkpoint: page.checkpoint,
  } satisfies DesktopNotificationPreference;
  saveDesktopNotificationPreference(input.storage, input.accountId, next);
  return next;
}

export async function pollDesktopNotifications(input: {
  accountId: string;
  client: DesktopNotificationClient;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  status: 'disabled' | 'complete' | 'interrupted';
  accepted: number;
  overflow: boolean;
}> {
  let preference = loadDesktopNotificationPreference(
    input.storage,
    input.accountId,
  );
  if (!preference.enabled)
    return { status: 'disabled', accepted: 0, overflow: false };
  const nativeStatus = await input.client.status();
  if (!nativeStatus.supported || nativeStatus.permission === 'denied') {
    saveDesktopNotificationPreference(input.storage, input.accountId, {
      ...preference,
      enabled: false,
    });
    return { status: 'interrupted', accepted: 0, overflow: false };
  }
  if (nativeStatus.permission !== 'granted')
    return { status: 'interrupted', accepted: 0, overflow: false };
  const page = await pollServer(
    input.accountId,
    preference.checkpoint,
    false,
    input.fetcher ?? fetch,
    input.signal,
  );
  let accepted = 0;
  for (const item of page.items) {
    if (input.signal?.aborted)
      return { status: 'interrupted', accepted, overflow: page.overflow };
    const result = await input.client.deliver(item, preference.privacyMode);
    if (result.outcome === 'accepted' || result.outcome === 'duplicate') {
      if (result.outcome === 'accepted') accepted += 1;
      preference = { ...preference, checkpoint: item.checkpoint };
      saveDesktopNotificationPreference(
        input.storage,
        input.accountId,
        preference,
      );
      continue;
    }
    if (result.outcome === 'permission_required') {
      saveDesktopNotificationPreference(input.storage, input.accountId, {
        ...preference,
        enabled: false,
      });
    }
    return { status: 'interrupted', accepted, overflow: page.overflow };
  }
  if (preference.checkpoint !== page.checkpoint) {
    preference = { ...preference, checkpoint: page.checkpoint };
    saveDesktopNotificationPreference(
      input.storage,
      input.accountId,
      preference,
    );
  }
  return { status: 'complete', accepted, overflow: page.overflow };
}

export function startDesktopNotificationPolling(input: {
  accountId: string;
  client: DesktopNotificationClient;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetcher?: typeof fetch;
  onFailure?: () => void;
}): () => void {
  const controller = new AbortController();
  let running = false;
  const poll = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      await pollDesktopNotifications({
        ...input,
        signal: controller.signal,
      });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError')
        return;
      input.onFailure?.();
    } finally {
      running = false;
    }
  };
  void poll();
  const timer = window.setInterval(() => void poll(), pollIntervalMilliseconds);
  return () => {
    controller.abort();
    window.clearInterval(timer);
  };
}

async function pollServer(
  accountId: string,
  checkpoint: string | null,
  initialize: boolean,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher('/v1/desktop-notification-deliveries/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId: accountId, checkpoint, initialize }),
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new DesktopNotificationError('unavailable');
  const parsed = desktopNotificationDeliveryPageSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) throw new DesktopNotificationError('invalid_response');
  return parsed.data;
}

function preferenceKey(accountId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(accountId))
    throw new DesktopNotificationError('invalid_input');
  return `${preferencePrefix}${accountId.toLowerCase()}`;
}

function isPreference(value: unknown): value is DesktopNotificationPreference {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.enabled === 'boolean' &&
    typeof value.privacyMode === 'boolean' &&
    (value.checkpoint === null ||
      (typeof value.checkpoint === 'string' &&
        value.checkpoint.length > 0 &&
        value.checkpoint.length <= 256 &&
        /^[A-Za-z0-9_-]+$/u.test(value.checkpoint)))
  );
}

function isStatus(value: unknown): value is DesktopNotificationStatus {
  return (
    isRecord(value) &&
    typeof value.supported === 'boolean' &&
    (value.permission === 'granted' ||
      value.permission === 'denied' ||
      value.permission === 'prompt' ||
      value.permission === 'unavailable')
  );
}

function isDeliveryResult(value: unknown): value is DesktopNotificationResult {
  return (
    isRecord(value) &&
    (value.outcome === 'accepted' ||
      value.outcome === 'duplicate' ||
      value.outcome === 'permission_required' ||
      value.outcome === 'rate_limited' ||
      value.outcome === 'delivery_failed') &&
    value.route === '/notifications' &&
    typeof value.retryAfterMilliseconds === 'number' &&
    Number.isInteger(value.retryAfterMilliseconds) &&
    value.retryAfterMilliseconds >= 0 &&
    value.retryAfterMilliseconds <= 60_000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
