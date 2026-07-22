import { createHash } from 'node:crypto';
import type { NotificationRecord } from './notifications.js';

export interface WebPushSubscription {
  id: string;
  accountId: string;
  endpointHash: string;
  active: boolean;
  expiresAt: string | null;
}
export interface WebNotificationGateway {
  subscriptions(accountId: string): Promise<WebPushSubscription[]>;
  mayDeliver(
    accountId: string,
    notification: NotificationRecord,
  ): Promise<boolean>;
  send(
    subscriptionId: string,
    payload: {
      notificationId: string;
      kind: string;
      route: string;
      tag: string;
    },
  ): Promise<'sent' | 'gone' | 'temporary_failure'>;
  deactivate(subscriptionId: string): Promise<void>;
}

export async function deliverWebNotification(
  gateway: WebNotificationGateway,
  notification: NotificationRecord,
): Promise<{ sent: number; failed: number }> {
  if (
    notification.archivedAt ||
    notification.readAt ||
    !(await gateway.mayDeliver(notification.accountId, notification))
  )
    return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const subscription of (
    await gateway.subscriptions(notification.accountId)
  ).slice(0, 20)) {
    if (
      !subscription.active ||
      (subscription.expiresAt && new Date() >= new Date(subscription.expiresAt))
    )
      continue;
    const result = await gateway.send(subscription.id, {
      notificationId: notification.id,
      kind: notification.kind,
      route: '/notifications',
      tag: createHash('sha256')
        .update(notification.deduplicationKey)
        .digest('hex')
        .slice(0, 32),
    });
    if (result === 'sent') sent += 1;
    else {
      failed += 1;
      if (result === 'gone') await gateway.deactivate(subscription.id);
    }
  }
  return { sent, failed };
}
