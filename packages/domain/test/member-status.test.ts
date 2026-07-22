import { describe, expect, it } from 'vitest';
import {
  MemberStatusService,
  type MemberStatus,
} from '../src/member-status.js';

describe('custom member status', () => {
  it('normalizes, expires, rechecks visibility, and rejects stale updates', async () => {
    let value: MemberStatus | undefined;
    let visible = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new MemberStatusService(
      {
        find: async () => value,
        save: async (next, expected) => {
          if (value?.version !== expected) return undefined;
          value = next;
          return next;
        },
      },
      { mayView: async () => visible },
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const status = await service.update(
      'u',
      '  Working   remotely ',
      '2026-01-02T00:00:00.000Z',
      undefined,
      now,
    );
    expect(status.text).toBe('Working remotely');
    expect(await service.view('v', 'u', new Date('2026-01-03'))).toBeNull();
    visible = false;
    expect(await service.view('v', 'u', now)).toBeNull();
    await expect(service.update('u', 'new', null, 9, now)).rejects.toThrow(
      'stale_member_status',
    );
  });
});
