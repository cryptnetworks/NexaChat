import { describe, expect, it } from 'vitest';
import {
  NotificationPreferenceService,
  type NotificationPreference,
  type NotificationPreferenceStore,
} from '../src/notifications.js';

describe('notification preferences', () => {
  it('uses secure defaults and most-specific current override with mute expiry', async () => {
    const values = new Map<string, NotificationPreference>();
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store: NotificationPreferenceStore = {
      find: async (a, t, id) => values.get(`${a}:${t}:${id}`),
      save: async (v: NotificationPreference, expected?: number) => {
        const key = `${v.accountId}:${v.scopeType}:${v.scopeId}`;
        const current = values.get(key);
        if (
          (current && current.version !== expected) ||
          (!current && expected !== undefined)
        )
          return undefined;
        values.set(key, v);
        return v;
      },
      transaction: <T>(
        work: (value: NotificationPreferenceStore) => Promise<T>,
      ) => work(store),
    };
    const service = new NotificationPreferenceService(store, {
      mayConfigure: () => Promise.resolve(true),
    });
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    expect(await service.effective('u', {}, 'invite', now)).toMatchObject({
      deliver: false,
      mode: 'mentions',
    });
    await service.update(
      'u',
      {
        scopeType: 'community',
        scopeId: 'c',
        mode: 'all',
        mutedUntil: '2026-01-02T00:00:00.000Z',
      },
      now,
    );
    expect(
      await service.effective('u', { communityId: 'c' }, 'mention', now),
    ).toMatchObject({ deliver: false, muted: true });
    expect(
      await service.effective(
        'u',
        { communityId: 'c' },
        'invite',
        new Date('2026-01-03'),
      ),
    ).toMatchObject({ deliver: true, muted: false });
  });
});
