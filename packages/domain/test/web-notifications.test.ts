import { describe, expect, it } from 'vitest';
import { deliverWebNotification } from '../src/web-notifications.js';

describe('web notification delivery', () => {
  it('enforces preferences and sends privacy-safe bounded payloads', async () => {
    let payload = '';
    let deactivated = '';
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const result = await deliverWebNotification(
      {
        subscriptions: async () => [
          {
            id: 'one',
            accountId: 'u',
            endpointHash: 'h',
            active: true,
            expiresAt: null,
          },
          {
            id: 'gone',
            accountId: 'u',
            endpointHash: 'g',
            active: true,
            expiresAt: null,
          },
        ],
        mayDeliver: async () => true,
        send: async (id, value) => {
          payload = JSON.stringify(value);
          return id === 'gone' ? 'gone' : 'sent';
        },
        deactivate: async (id) => {
          deactivated = id;
        },
      },
      {
        id: 'n',
        accountId: 'u',
        kind: 'mention',
        scopeId: 's',
        resourceId: 'private-message',
        actorIds: ['a'],
        count: 1,
        deduplicationKey: 'key',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        readAt: null,
        archivedAt: null,
        expiresAt: '2026-02-01',
        version: 1,
      },
    );
    /* eslint-enable @typescript-eslint/require-await */
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(payload).not.toContain('private-message');
    expect(deactivated).toBe('gone');
  });
});
