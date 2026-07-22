import { describe, expect, it } from 'vitest';
import { PresenceService, type PresenceValue } from '../src/presence.js';

describe('bounded presence', () => {
  it('expires, rate limits, hides blocked users, and shares coordination state', async () => {
    let value: PresenceValue | undefined;
    let allowed = true;
    let visible = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new PresenceService(
      {
        get: async () => value,
        set: async (v, ttl) => {
          expect(ttl).toBe(90);
          value = v;
        },
        publish: async () => {},
        allowUpdate: async () => allowed,
      },
      { mayView: async () => visible },
    );
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    await service.heartbeat('u', true, now);
    expect(await service.view('viewer', 'u', now)).toBe('online');
    expect(
      await service.view('viewer', 'u', new Date(now.getTime() + 90_001)),
    ).toBe('offline');
    visible = false;
    expect(await service.view('viewer', 'u', now)).toBe('offline');
    allowed = false;
    await expect(service.heartbeat('u', true, now)).rejects.toThrow(
      'presence_rate_limited',
    );
  });
});
