import { jsonMutationHeaders } from './http.js';

export async function requestWebNotificationOptIn(
  permission: NotificationPermission,
  request: () => Promise<NotificationPermission>,
): Promise<'enabled' | 'denied' | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const result = permission === 'default' ? await request() : permission;
  return result === 'granted' ? 'enabled' : 'denied';
}

export async function enableWebNotifications(
  accountId: string,
): Promise<
  | { status: 'enabled'; subscriptionId: string }
  | { status: 'denied' | 'unsupported' | 'unavailable' }
> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return { status: 'unsupported' };
  const permission = await requestWebNotificationOptIn(
    Notification.permission,
    () => Notification.requestPermission(),
  );
  if (permission !== 'enabled') return { status: permission };
  const configuration = await fetch('/v1/web-push/config').then((response) =>
    response.ok
      ? (response.json() as Promise<{
          enabled: boolean;
          publicKey: string | null;
        }>)
      : Promise.reject(new Error('unavailable')),
  );
  if (!configuration.enabled || !configuration.publicKey)
    return { status: 'unavailable' };
  const registration = await navigator.serviceWorker.register(
    '/service-worker.js',
    { scope: '/' },
  );
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeApplicationServerKey(configuration.publicKey),
  });
  const response = await fetch('/v1/web-push/subscriptions', {
    method: 'POST',
    headers: jsonMutationHeaders(),
    body: JSON.stringify({
      actorId: accountId,
      subscription: subscription.toJSON(),
    }),
  });
  if (!response.ok) {
    await subscription.unsubscribe().catch(() => false);
    return { status: 'unavailable' };
  }
  const saved = (await response.json()) as { id: string };
  return { status: 'enabled', subscriptionId: saved.id };
}

export async function disableWebNotifications(
  accountId: string,
  subscriptionId: string,
): Promise<boolean> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  const response = await fetch(`/v1/web-push/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: jsonMutationHeaders(),
    body: JSON.stringify({ actorId: accountId }),
  });
  if (!response.ok && response.status !== 404) return false;
  await subscription?.unsubscribe().catch(() => false);
  return true;
}

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
