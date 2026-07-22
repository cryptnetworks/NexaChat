import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { Pool } from 'pg';
import webPush, { type PushSubscription } from 'web-push';
import {
  deliverWebNotification,
  type NotificationAuthorization,
  type NotificationPreferenceService,
  type NotificationRecord,
  type WebNotificationGateway,
  type WebPushSubscription,
} from '@nexa/domain';

export interface WebPushRuntimeConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  allowedHosts: string[];
}
export interface WebPushController {
  readonly config: WebPushRuntimeConfig;
  register(
    accountId: string,
    input: {
      endpoint: string;
      expirationTime: number | null;
      keys: { p256dh: string; auth: string };
    },
  ): Promise<WebPushSubscription>;
  revoke(accountId: string, subscriptionId: string): Promise<void>;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  endpoint_ciphertext: Buffer;
  endpoint_hash: string;
  key_ciphertext: Buffer;
  active: boolean;
  expires_at: Date | string | null;
}

export class WebPushRuntime
  implements WebNotificationGateway, WebPushController
{
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly pool: Pool,
    readonly config: WebPushRuntimeConfig,
    private readonly authorization: NotificationAuthorization,
    private readonly preferences: NotificationPreferenceService,
  ) {
    this.encryptionKey = Buffer.from(config.encryptionKey, 'base64url');
    if (this.encryptionKey.length !== 32)
      throw new Error('invalid_web_push_key');
    webPush.setVapidDetails(
      config.subject,
      config.publicKey,
      config.privateKey,
    );
  }

  async register(
    accountId: string,
    input: {
      endpoint: string;
      expirationTime: number | null;
      keys: { p256dh: string; auth: string };
    },
  ): Promise<WebPushSubscription> {
    const endpoint = new URL(input.endpoint);
    if (
      endpoint.protocol !== 'https:' ||
      !this.config.allowedHosts.some((allowed) =>
        allowed.startsWith('.')
          ? endpoint.hostname.endsWith(allowed)
          : endpoint.hostname === allowed,
      ) ||
      input.endpoint.length > 2048 ||
      input.keys.p256dh.length > 512 ||
      input.keys.auth.length > 256 ||
      (input.expirationTime !== null && input.expirationTime <= Date.now())
    )
      throw new Error('invalid_web_push_subscription');
    const endpointHash = createHash('sha256')
      .update(input.endpoint)
      .digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`web-push:${accountId}`],
      );
      const endpointCiphertext = this.encrypt(
        input.endpoint,
        `${accountId}:${endpointHash}:endpoint`,
      );
      const keyCiphertext = this.encrypt(
        JSON.stringify(input.keys),
        `${accountId}:${endpointHash}:keys`,
      );
      const result = await client.query<SubscriptionRow>(
        `INSERT INTO web_push_subscriptions
         (id,account_id,endpoint_ciphertext,endpoint_hash,key_ciphertext,
          active,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,true,CURRENT_TIMESTAMP,$6)
         ON CONFLICT (account_id,endpoint_hash) DO UPDATE SET
           endpoint_ciphertext=EXCLUDED.endpoint_ciphertext,
           key_ciphertext=EXCLUDED.key_ciphertext,active=true,
           expires_at=EXCLUDED.expires_at
         RETURNING id,account_id,endpoint_ciphertext,endpoint_hash,
           key_ciphertext,active,expires_at`,
        [
          randomUUID(),
          accountId,
          endpointCiphertext,
          endpointHash,
          keyCiphertext,
          input.expirationTime === null
            ? null
            : new Date(input.expirationTime).toISOString(),
        ],
      );
      await client.query(
        `UPDATE web_push_subscriptions SET active=false WHERE id IN (
           SELECT id FROM web_push_subscriptions WHERE account_id=$1
           AND active=true ORDER BY created_at DESC,id DESC OFFSET 20
         )`,
        [accountId],
      );
      const subscription = result.rows[0];
      if (!subscription) throw new Error('web_push_registration_failed');
      await client.query('COMMIT');
      return this.publicSubscription(subscription);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(accountId: string, subscriptionId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE web_push_subscriptions SET active=false
       WHERE id=$1 AND account_id=$2 AND active=true`,
      [subscriptionId, accountId],
    );
    if (result.rowCount !== 1)
      throw new Error('web_push_subscription_not_found');
  }

  async subscriptions(accountId: string): Promise<WebPushSubscription[]> {
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT id,account_id,endpoint_ciphertext,endpoint_hash,key_ciphertext,
       active,expires_at FROM web_push_subscriptions WHERE account_id=$1
       AND active=true ORDER BY id LIMIT 20`,
      [accountId],
    );
    return result.rows.map((row) => this.publicSubscription(row));
  }

  async mayDeliver(
    accountId: string,
    notification: NotificationRecord,
  ): Promise<boolean> {
    if (
      !(await this.authorization.mayView(
        accountId,
        notification.resourceId,
        notification.kind,
        notification.scopeId,
      ))
    )
      return false;
    const preference = await this.preferences.effective(
      accountId,
      notification.scopeId ? { spaceId: notification.scopeId } : {},
      notification.kind,
      new Date(),
    );
    return preference.deliver;
  }

  async send(
    subscriptionId: string,
    payload: {
      notificationId: string;
      kind: string;
      route: string;
      tag: string;
    },
  ): Promise<'sent' | 'gone' | 'temporary_failure'> {
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT id,account_id,endpoint_ciphertext,endpoint_hash,key_ciphertext,
       active,expires_at FROM web_push_subscriptions WHERE id=$1 AND active=true`,
      [subscriptionId],
    );
    const row = result.rows[0];
    if (!row) return 'gone';
    const subscription: PushSubscription = {
      endpoint: this.decrypt(
        row.endpoint_ciphertext,
        `${row.account_id}:${row.endpoint_hash}:endpoint`,
      ),
      keys: JSON.parse(
        this.decrypt(
          row.key_ciphertext,
          `${row.account_id}:${row.endpoint_hash}:keys`,
        ),
      ) as PushSubscription['keys'],
    };
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 300,
        urgency: 'normal',
        topic: payload.tag,
      });
      return 'sent';
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : undefined;
      return statusCode === 404 || statusCode === 410
        ? 'gone'
        : 'temporary_failure';
    }
  }

  async deactivate(subscriptionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE web_push_subscriptions SET active=false WHERE id=$1',
      [subscriptionId],
    );
  }

  deliver(notification: NotificationRecord) {
    return deliverWebNotification(this, notification);
  }

  private publicSubscription(row: SubscriptionRow): WebPushSubscription {
    return {
      id: row.id,
      accountId: row.account_id,
      endpointHash: row.endpoint_hash,
      active: row.active,
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at.toISOString()
          : row.expires_at,
    };
  }

  private encrypt(value: string, associatedData: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(associatedData));
    return Buffer.concat([
      nonce,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }

  private decrypt(value: Buffer, associatedData: string): string {
    if (value.length < 29) throw new Error('invalid_web_push_ciphertext');
    const nonce = value.subarray(0, 12);
    const tag = value.subarray(value.length - 16);
    const ciphertext = value.subarray(12, value.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
