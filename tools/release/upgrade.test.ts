import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluatePostflight,
  evaluatePreflight,
  loadUpgradePolicy,
  UpgradeValidationError,
} from './upgrade.js';

const fixtureDirectory = resolve(import.meta.dirname, 'fixtures/upgrade');

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(resolve(fixtureDirectory, name), 'utf8'),
  ) as Record<string, unknown>;
}

describe('supported upgrade policy', () => {
  it('matches repository, migration, and runtime configuration versions', async () => {
    const policy = await loadUpgradePolicy();
    expect(policy).toMatchObject({
      targetVersion: '0.1.0',
      database: { targetSchema: 41 },
      configuration: { targetSchema: 1 },
    });
  });

  it('accepts complete preflight evidence without returning private evidence', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('preflight-valid.json');
    const result = evaluatePreflight(policy, evidence);
    expect(result).toMatchObject({
      phase: 'preflight',
      status: 'accepted',
      targetVersion: '0.1.0',
      failures: [],
    });
    expect(result.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('synthetic-restore-test');
  });

  it('accepts a clean installation only with an empty schema and no source identity', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('preflight-valid.json');
    evidence.sourceVersion = null;
    evidence.sourceChannel = null;
    evidence.databaseSchema = 0;
    evidence.backup = {
      status: 'not-required',
      verifiedAt: null,
      restoreTestId: null,
    };
    expect(evaluatePreflight(policy, evidence).status).toBe('accepted');
    evidence.databaseSchema = 1;
    expect(evaluatePreflight(policy, evidence).failures).toContain(
      'clean_install_database_not_empty',
    );
  });

  it('rejects unsupported channels, stale backups, races, jobs, and low space together', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('preflight-valid.json');
    evidence.sourceChannel = 'beta';
    evidence.backup = {
      status: 'verified',
      verifiedAt: '2026-07-20T00:00:00.000Z',
      restoreTestId: 'old-restore',
    };
    evidence.space = {
      availableBytes: 1,
      estimatedInstallBytes: 100,
      estimatedDatabaseGrowthBytes: 100,
    };
    evidence.maintenance = {
      enabled: false,
      activeOldVersionInstances: 1,
      runningJobs: 2,
    };
    expect(evaluatePreflight(policy, evidence)).toMatchObject({
      status: 'rejected',
      failures: [
        'backup_stale',
        'channel_path_unsupported',
        'insufficient_space',
        'jobs_not_quiescent',
        'maintenance_required',
        'old_instances_not_drained',
      ],
    });
  });

  it('rejects an ahead database without attempting a downgrade', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('preflight-valid.json');
    evidence.databaseSchema = 42;
    expect(evaluatePreflight(policy, evidence).failures).toContain(
      'database_schema_ahead',
    );
  });

  it('accepts complete postflight evidence and rejects every failed invariant', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('postflight-valid.json');
    const preflight = evaluatePreflight(
      policy,
      await fixture('preflight-valid.json'),
    );
    expect(evaluatePostflight(policy, evidence, preflight.planId).status).toBe(
      'accepted',
    );
    evidence.databaseSchema = 40;
    evidence.ready = false;
    evidence.errorRateBasisPoints = 101;
    evidence.rollbackCheckpointRetained = false;
    evidence.probes = {
      ...(evidence.probes as Record<string, boolean>),
      'authorization-websocket': false,
    };
    expect(
      evaluatePostflight(policy, evidence, preflight.planId).failures,
    ).toEqual([
      'database_schema_mismatch',
      'error_budget_exceeded',
      'probe_failed:authorization-websocket',
      'readiness_failed',
      'rollback_checkpoint_missing',
    ]);
    evidence.preflightPlanId = '0'.repeat(64);
    expect(
      evaluatePostflight(policy, evidence, preflight.planId).failures,
    ).toContain('preflight_plan_mismatch');
  });

  it('fails closed on unknown or malformed evidence fields', async () => {
    const policy = await loadUpgradePolicy();
    const evidence = await fixture('preflight-valid.json');
    evidence.secret = 'must never be accepted';
    expect(() => evaluatePreflight(policy, evidence)).toThrow(
      UpgradeValidationError,
    );
  });
});
