import { describe, expect, it } from 'vitest';
import {
  NotificationPreferenceService,
  type NotificationPreference,
} from '../src/notifications.js';

describe('notification preferences', () => {
  it('uses secure defaults and most-specific current override with mute expiry', async () => {
    const values = new Map<string, NotificationPreference>();
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new NotificationPreferenceService({
      find: async (a, t, id) => values.get(`${a}:${t}:${id}`),
      save: async (v, expected) => {
        const k = `${v.accountId}:${v.scopeType}:${v.scopeId}`;
        const c = values.get(k);
        if ((c && c.version !== expected) || (!c && expected !== undefined))
          return undefined;
        values.set(k, v);
        return v;
      },
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
