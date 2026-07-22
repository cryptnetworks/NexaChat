'use strict';

/**
 * @typedef {{ notificationId: string, kind: string, route: '/notifications', tag: string }} NotificationPayload
 */

/** @type {ServiceWorkerGlobalScope} */
const serviceWorker = /** @type {ServiceWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);

/**
 * @param {unknown} value
 * @returns {value is NotificationPayload}
 */
function isNotificationPayload(value) {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof candidate.notificationId === 'string' &&
    typeof candidate.kind === 'string' &&
    candidate.route === '/notifications' &&
    typeof candidate.tag === 'string' &&
    candidate.tag.length <= 64
  );
}

serviceWorker.addEventListener('push', (event) => {
  /** @type {unknown} */
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!isNotificationPayload(payload)) return;
  event.waitUntil(
    serviceWorker.registration.showNotification('NexaChat notification', {
      body: 'Open NexaChat to view this update.',
      tag: payload.tag,
      data: { route: '/notifications' },
    }),
  );
});

serviceWorker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    serviceWorker.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const current = clients[0];
        if (current) {
          return current.navigate('/notifications').then(() => current.focus());
        }
        return serviceWorker.clients.openWindow('/notifications');
      }),
  );
});
