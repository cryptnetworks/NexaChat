export type SessionSignal =
  'credentials_rotated' | 'sessions_changed' | 'signed_out';

const channelName = 'nexa-session-v1';
const storageKey = 'nexa-session-signal-v1';
let sharedChannel: BroadcastChannel | undefined;
const allowed = new Set<SessionSignal>([
  'credentials_rotated',
  'sessions_changed',
  'signed_out',
]);

export function parseSessionSignal(value: unknown): SessionSignal | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    Object.keys(value).length === 1 &&
    allowed.has(value.type as SessionSignal)
  )
    return value.type as SessionSignal;
  return undefined;
}

export function publishSessionSignal(type: SessionSignal): void {
  const payload = { type };
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = (sharedChannel ??= new BroadcastChannel(channelName));
    channel.postMessage(payload);
    return;
  }
  try {
    localStorage.removeItem(storageKey);
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Server-side session enforcement remains authoritative if storage is off.
  }
}

export function subscribeSessionSignals(
  listener: (signal: SessionSignal) => void,
): () => void {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = (sharedChannel ??= new BroadcastChannel(channelName));
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const signal = parseSessionSignal(event.data);
      if (signal) listener(signal);
    };
    return () => {
      channel.onmessage = null;
    };
  }
  const receive = (event: StorageEvent) => {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      const signal = parseSessionSignal(JSON.parse(event.newValue));
      if (signal) listener(signal);
    } catch {
      // Ignore malformed values written by unrelated same-origin code.
    }
  };
  addEventListener('storage', receive);
  return () => {
    removeEventListener('storage', receive);
  };
}
