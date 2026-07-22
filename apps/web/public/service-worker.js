'use strict';

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (
    !payload ||
    typeof payload.notificationId !== 'string' ||
    typeof payload.kind !== 'string' ||
    payload.route !== '/notifications' ||
    typeof payload.tag !== 'string' ||
    payload.tag.length > 64
  )
    return;
  event.waitUntil(
    self.registration.showNotification('NexaChat notification', {
      body: 'Open NexaChat to view this update.',
      tag: payload.tag,
      data: { route: '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const current = clients[0];
        if (current) {
          current.navigate('/notifications');
          return current.focus();
        }
        return self.clients.openWindow('/notifications');
      }),
  );
});
