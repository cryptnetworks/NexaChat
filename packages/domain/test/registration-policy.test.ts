import { describe, expect, it } from 'vitest';
import {
  RegistrationPolicyService,
  type RegistrationPolicy,
} from '../src/administration.js';

describe('registration policy', () => {
  it('defaults closed, enforces invite-only, and audits versioned changes', async () => {
    let policy: RegistrationPolicy | undefined;
    const audits: string[] = [];
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store = {
      effectiveConfiguration: async () => ({}),
      dependencyHealth: async () => ({}),
      migrationVersion: async () => ({ current: 37, expected: 37 }),
      latestAuditHash: async () => undefined,
      appendAudit: async (e: { action: string }) => {
        audits.push(e.action);
      },
      policy: async () => policy,
      savePolicy: async (v: RegistrationPolicy, expected?: number) => {
        if (policy?.version !== expected) return undefined;
        policy = v;
        return v;
      },
    };
    const service = new RegistrationPolicyService(store, {
      assertPermission: async () => {},
      assertRecentAuth: async () => {},
    });
    /* eslint-enable @typescript-eslint/require-await */
    await expect(service.assertRegistrationAllowed(false)).rejects.toThrow(
      'registration_unavailable',
    );
    await service.update(
      'admin',
      'invite_only',
      undefined,
      'recent',
      'c',
      new Date('2026-01-01'),
    );
    await service.assertRegistrationAllowed(true);
    await expect(service.assertRegistrationAllowed(false)).rejects.toThrow(
      'registration_unavailable',
    );
    expect(audits).toContain('registration_policy.update');
  });
});
