export async function requestWebNotificationOptIn(
  permission: NotificationPermission,
  request: () => Promise<NotificationPermission>,
): Promise<'enabled' | 'denied' | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const result = permission === 'default' ? await request() : permission;
  return result === 'granted' ? 'enabled' : 'denied';
}
