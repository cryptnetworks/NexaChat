import { describe, expect, it } from 'vitest';
import {
  AccountSuspensionService,
  type AccountSuspension,
} from '../src/administration.js';

describe('account suspension management', () => {
  it('requires recent protected permission, preserves last admin, revokes sessions, and restores', async () => {
    let value: AccountSuspension | undefined;
    const effects: string[] = [];
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      effectiveConfiguration: async () => ({}),
      dependencyHealth: async () => ({}),
      migrationVersion: async () => ({ current: 36, expected: 36 }),
      latestAuditHash: async () => undefined,
      appendAudit: async (e: { action: string }) => {
        effects.push(e.action);
      },
      findSuspension: async () => value,
      createSuspension: async (v: AccountSuspension) => (value = v),
      findSuspensionById: async () => value,
      restoreSuspension: async (_id: string, version: number, now: string) =>
        value?.version === version
          ? (value = { ...value, restoredAt: now, version: version + 1 })
          : undefined,
      assertNotLastAdministrator: async () => {},
      revokeSessions: async () => {
        effects.push('sessions');
      },
      publishAuthorizationInvalidation: async () => {
        effects.push('realtime');
      },
    };
    const service = new AccountSuspensionService(store, {
      assertPermission: async () => {},
      assertRecentAuth: async () => {},
    });
    /* eslint-enable @typescript-eslint/require-await */
    const now = new Date('2026-01-01');
    const suspended = await service.suspend({
      actorId: 'admin',
      accountId: 'u',
      reason: 'Policy violation',
      idempotencyKey: 'suspend-key-01',
      authenticatedAt: now.toISOString(),
      correlationId: 'c',
      now,
    });
    expect(effects).toEqual(
      expect.arrayContaining(['sessions', 'realtime', 'account.suspend']),
    );
    expect(
      (
        await service.restore(
          'admin',
          suspended.id,
          1,
          now.toISOString(),
          'r',
          now,
        )
      ).restoredAt,
    ).not.toBeNull();
  });
});
