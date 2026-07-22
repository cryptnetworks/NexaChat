import { describe, expect, it } from 'vitest';
import { AdministrationService } from '../src/administration.js';

describe('administration console', () => {
  it('requires protected permission and redacts effective configuration', async () => {
    let allowed = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new AdministrationService(
      {
        effectiveConfiguration: async () => ({
          environment: 'production',
          databaseUrl: 'postgres://private',
          signingSecret: 'private',
        }),
        dependencyHealth: async () => ({
          postgres: 'healthy',
          valkey: 'degraded',
        }),
        migrationVersion: async () => ({ current: 35, expected: 35 }),
        latestAuditHash: async () => undefined,
        appendAudit: async () => {},
      },
      {
        assertPermission: async () => {
          if (!allowed) throw new Error('forbidden');
        },
        assertRecentAuth: async () => {},
      },
    );
    /* eslint-enable @typescript-eslint/require-await */
    expect(await service.overview('admin')).toMatchObject({
      configuration: {
        environment: 'production',
        databaseUrl: '[configured]',
        signingSecret: '[configured]',
      },
    });
    allowed = false;
    await expect(service.overview('user')).rejects.toThrow('forbidden');
  });
});
