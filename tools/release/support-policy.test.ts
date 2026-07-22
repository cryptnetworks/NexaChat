import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateRollingCompatibility,
  loadSupportPolicy,
  SupportPolicyError,
} from './support-policy.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(
  ROOT,
  'tools/release/fixtures/compatibility/same-version-rolling.json',
);
const COMMIT = '3a6b63bf609add01eae5205c8a3cf8d465a60da5';

async function evidence(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid compatibility fixture');
  }
  return structuredClone(value) as Record<string, unknown>;
}

describe('support and compatibility policy', () => {
  it('matches current toolchains, release matrices, schemas, contracts, and documentation', async () => {
    const policy = await loadSupportPolicy(ROOT);
    expect(policy).toMatchObject({
      targetVersion: '0.1.0',
      productStatus: 'pre-release-no-supported-production-version',
      activationGate: 'release-candidate-go',
    });
    expect(
      policy.environments.web.browsers.map(({ family }) => family),
    ).toEqual(['chrome', 'edge', 'firefox', 'safari']);
    expect(
      policy.environments.desktop.flatMap(({ platform, architectures }) =>
        architectures.map((arch) => `${platform}/${arch}`),
      ),
    ).toEqual(['linux/x64', 'macos/arm64', 'macos/x64', 'windows/x64']);
    expect(policy.review.requiredCandidateChecks).toEqual([
      'compatibility-review',
      'rolling-upgrade',
    ]);
  });

  it('accepts only the declared same-version two-replica rolling scenario', async () => {
    const policy = await loadSupportPolicy(ROOT);
    const decision = evaluateRollingCompatibility(
      policy,
      await evidence(),
      COMMIT,
    );
    expect(decision).toMatchObject({
      scenarioId: 'same-version-two-replica',
      commit: COMMIT,
      status: 'supported',
      failures: [],
    });
    expect(decision.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects version, schema, protocol, topology, coordination, and failed-check drift together', async () => {
    const policy = await loadSupportPolicy(ROOT);
    const value = await evidence();
    value.commit = 'a'.repeat(40);
    value.schemaChange = true;
    value.source = {
      version: '0.0.9',
      httpVersion: 2,
      realtimeVersion: 2,
      databaseSchema: 40,
      configurationSchema: 2,
    };
    value.topology = {
      oldInstances: 0,
      newInstances: 1,
      coordination: 'local',
    };
    const checks = value.checks as Array<Record<string, unknown>>;
    const first = checks[0];
    if (!first) throw new Error('missing fixture check');
    first.status = 'failed';

    const decision = evaluateRollingCompatibility(policy, value, COMMIT);
    expect(decision.status).toBe('rejected');
    expect(decision.failures).toEqual([
      'check_failed:authorization-revalidated',
      'commit_mismatch',
      'coordination_mismatch',
      'rolling_topology_insufficient',
      'schema_change_unsupported',
      'source_configuration_schema_mismatch',
      'source_database_schema_mismatch',
      'source_http_version_mismatch',
      'source_realtime_version_mismatch',
      'source_version_mismatch',
    ]);
  });

  it('rejects unknown fields and unverifiable completed checks', async () => {
    const policy = await loadSupportPolicy(ROOT);
    const unknown = await evidence();
    unknown.privateProviderLog = 'not allowed';
    expect(() => evaluateRollingCompatibility(policy, unknown, COMMIT)).toThrow(
      new SupportPolicyError('invalid_rolling_evidence'),
    );

    const missingDigest = await evidence();
    const checks = missingDigest.checks as Array<Record<string, unknown>>;
    const first = checks[0];
    if (!first) throw new Error('missing fixture check');
    first.evidenceSha256 = null;
    expect(() =>
      evaluateRollingCompatibility(policy, missingDigest, COMMIT),
    ).toThrow(new SupportPolicyError('invalid_rolling_check_evidence'));
  });
});
