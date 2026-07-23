import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopNotificationControls } from './desktop-notification-controls.js';
import {
  createDesktopNotificationClient,
  initializeDesktopNotifications,
  loadDesktopNotificationPreference,
  pollDesktopNotifications,
  saveDesktopNotificationPreference,
  type DesktopNotificationClient,
} from './desktop-notifications.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const checkpointOne = Buffer.from('checkpoint-one').toString('base64url');
const checkpointTwo = Buffer.from('checkpoint-two').toString('base64url');

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

function client(
  outcomes: Array<
    'accepted' | 'duplicate' | 'rate_limited' | 'delivery_failed'
  > = ['accepted'],
): DesktopNotificationClient {
  let call = 0;
  return {
    status: () => Promise.resolve({ supported: true, permission: 'granted' }),
    requestPermission: () =>
      Promise.resolve({ supported: true, permission: 'granted' }),
    deliver: () =>
      Promise.resolve({
        outcome: outcomes[call++] ?? 'accepted',
        route: '/notifications',
        retryAfterMilliseconds: 0,
      }),
  };
}

function response(
  items: Array<{
    notificationId: string;
    checkpoint: string;
  }>,
  checkpoint: string | null,
) {
  return new Response(
    JSON.stringify({
      items: items.map((item, index) => ({
        notificationId: item.notificationId,
        kind: index === 0 ? 'mention' : 'reply',
        version: 1,
        route: '/notifications',
        checkpoint: item.checkpoint,
      })),
      checkpoint,
      overflow: false,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('desktop notification bridge', () => {
  it('is unavailable in browsers and accepts only bounded native results', async () => {
    expect(createDesktopNotificationClient(vi.fn(), false)).toBeUndefined();
    const invoke = vi.fn((command: string) =>
      Promise.resolve(
        command === 'desktop_notification_status'
          ? { supported: true, permission: 'granted' }
          : {
              outcome: 'accepted',
              route: '/notifications',
              retryAfterMilliseconds: 0,
            },
      ),
    );
    const desktop = createDesktopNotificationClient(invoke, true);
    if (!desktop) throw new Error('desktop bridge unavailable');
    expect(await desktop.status()).toEqual({
      supported: true,
      permission: 'granted',
    });
    expect(
      await desktop.deliver(
        {
          notificationId: firstId,
          kind: 'mention',
          version: 1,
          route: '/notifications',
          checkpoint: checkpointOne,
        },
        true,
      ),
    ).toMatchObject({ outcome: 'accepted' });
    expect(invoke).toHaveBeenLastCalledWith('deliver_desktop_notification', {
      request: {
        notificationId: firstId,
        kind: 'mention',
        version: 1,
        route: '/notifications',
        privacyMode: true,
      },
    });
  });
});

describe('desktop notification polling', () => {
  it('persists an account-scoped baseline without replaying history', async () => {
    const local = storage();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(response([], checkpointOne));
    });
    const preference = await initializeDesktopNotifications({
      accountId,
      client: client(),
      storage: local,
      fetcher: fetchMock,
    });
    expect(preference).toEqual({
      version: 1,
      enabled: true,
      privacyMode: true,
      checkpoint: checkpointOne,
    });
    const requestOptions = fetchMock.mock.calls.at(0)?.[1];
    expect(new Headers(requestOptions?.headers).get('x-nexa-csrf')).toBe('1');
    const requestBody = requestOptions?.body;
    if (typeof requestBody !== 'string')
      throw new Error('missing request body');
    const request = JSON.parse(requestBody) as Record<string, unknown>;
    expect(request).toEqual({
      actorId: accountId,
      checkpoint: null,
      initialize: true,
    });
  });

  it('checkpoints each accepted or duplicate envelope for restart safety', async () => {
    const local = storage();
    saveDesktopNotificationPreference(local, accountId, {
      version: 1,
      enabled: true,
      privacyMode: true,
      checkpoint: checkpointOne,
    });
    const native = client(['accepted', 'duplicate']);
    const deliver = vi.spyOn(native, 'deliver');
    const result = await pollDesktopNotifications({
      accountId,
      client: native,
      storage: local,
      fetcher: () =>
        Promise.resolve(
          response(
            [
              { notificationId: firstId, checkpoint: checkpointOne },
              { notificationId: secondId, checkpoint: checkpointTwo },
            ],
            checkpointTwo,
          ),
        ),
    });
    expect(result).toEqual({
      status: 'complete',
      accepted: 1,
      overflow: false,
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(loadDesktopNotificationPreference(local, accountId).checkpoint).toBe(
      checkpointTwo,
    );
  });

  it('preserves the last successful checkpoint after a recoverable failure', async () => {
    const local = storage();
    saveDesktopNotificationPreference(local, accountId, {
      version: 1,
      enabled: true,
      privacyMode: false,
      checkpoint: null,
    });
    const result = await pollDesktopNotifications({
      accountId,
      client: client(['accepted', 'rate_limited']),
      storage: local,
      fetcher: () =>
        Promise.resolve(
          response(
            [
              { notificationId: firstId, checkpoint: checkpointOne },
              { notificationId: secondId, checkpoint: checkpointTwo },
            ],
            checkpointTwo,
          ),
        ),
    });
    expect(result.status).toBe('interrupted');
    expect(loadDesktopNotificationPreference(local, accountId)).toMatchObject({
      privacyMode: false,
      checkpoint: checkpointOne,
    });
  });

  it('stops before polling when operating-system permission is revoked', async () => {
    const local = storage();
    saveDesktopNotificationPreference(local, accountId, {
      version: 1,
      enabled: true,
      privacyMode: true,
      checkpoint: checkpointOne,
    });
    const fetcher = vi.fn(() => Promise.reject(new Error('must not poll')));
    const result = await pollDesktopNotifications({
      accountId,
      client: {
        ...client(),
        status: () =>
          Promise.resolve({ supported: true, permission: 'denied' }),
      },
      storage: local,
      fetcher,
    });
    expect(result.status).toBe('interrupted');
    expect(fetcher).not.toHaveBeenCalled();
    expect(loadDesktopNotificationPreference(local, accountId).enabled).toBe(
      false,
    );
  });
});

describe('desktop notification controls', () => {
  it('provides explicit keyboard controls and privacy explanation', () => {
    const markup = renderToStaticMarkup(
      <DesktopNotificationControls
        accountId={accountId}
        clientOverride={client()}
        storageOverride={storage()}
      />,
    );
    expect(markup).toContain('Turn on desktop notifications');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('Privacy mode hides');
    expect(markup).toContain('aria-live="polite"');
  });
});
