import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CandidateValidationError,
  evaluateCandidate,
  loadCandidatePolicy,
} from './candidate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_PATH = resolve(
  ROOT,
  'tools/release/fixtures/candidate/no-go-local.json',
);
const COMMIT = '8df6623867721bd1fd8d491fcfb463393ebc9dec';

interface FixtureCheck {
  id: string;
  status: 'passed' | 'failed' | 'not-run';
  evidenceSha256: string | null;
}

interface FixtureArtifact {
  name: string;
  sha256: string;
  manifestSha256: string;
  sourceCommit: string;
  sboms: { cargo: string; npm: string };
  detachedSignature: {
    status: 'passed' | 'failed' | 'not-run';
    keyEnvironment: 'test' | 'production' | null;
    keyId: string | null;
  };
  nativeSignature: {
    status: 'passed' | 'failed' | 'not-run' | 'not-required';
    identity: string | null;
  };
  attestation: {
    status: 'passed' | 'failed' | 'not-run';
    digest: string | null;
  };
}

interface FixtureTarget {
  platform: 'linux' | 'macos' | 'windows';
  arch: 'arm64' | 'x64';
  environment: Record<string, string>;
  artifact: FixtureArtifact | null;
  checks: FixtureCheck[];
}

interface FixtureEvidence extends Record<string, unknown> {
  commit: string;
  locks: Array<{ path: string; sha256: string }>;
  globalChecks: FixtureCheck[];
  targets: FixtureTarget[];
  residualRisks: Array<Record<string, unknown>>;
  decision: {
    status: 'go' | 'no-go';
    decidedAt: string;
    decidedBy: string | null;
    rationale: string;
  };
}

function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

async function fixture(): Promise<FixtureEvidence> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid test fixture');
  }
  return structuredClone(parsed) as FixtureEvidence;
}

async function passingEvidence(): Promise<FixtureEvidence> {
  const policy = await loadCandidatePolicy(ROOT);
  const evidence = await fixture();
  for (const lock of evidence.locks) {
    lock.sha256 = createHash('sha256')
      .update(await readFile(resolve(ROOT, lock.path)))
      .digest('hex');
  }
  evidence.globalChecks = policy.requiredGlobalChecks.map((id) => ({
    id,
    status: 'passed',
    evidenceSha256: hash(`global:${id}`),
  }));
  evidence.targets = policy.requiredTargets.map(({ platform, arch }) => {
    const key = `${platform}/${arch}`;
    const needsNative = platform === 'macos' || platform === 'windows';
    const extension =
      platform === 'linux' ? 'AppImage' : platform === 'macos' ? 'dmg' : 'msi';
    return {
      platform,
      arch,
      environment: {
        os: { linux: 'Linux', macos: 'macOS', windows: 'Windows' }[platform],
        osVersion: 'test-version',
        runnerImage: 'test-pinned-image',
        node: '24.18.0',
        npm: '11.16.0',
        rust: '1.97.1',
        tauri: '2.11.4',
      },
      artifact: {
        name: `NexaChat-0.1.0-beta-${platform}-${arch}.${extension}`,
        sha256: hash(`artifact:${key}`),
        manifestSha256: hash(`manifest:${key}`),
        sourceCommit: COMMIT,
        sboms: {
          cargo: hash(`cargo-sbom:${key}`),
          npm: hash(`npm-sbom:${key}`),
        },
        detachedSignature: {
          status: 'passed',
          keyEnvironment: 'production',
          keyId: `sha256:${hash(`key:${key}`)}`,
        },
        nativeSignature: needsNative
          ? { status: 'passed', identity: `test identity ${key}` }
          : { status: 'not-required', identity: null },
        attestation: {
          status: 'passed',
          digest: hash(`attestation:${key}`),
        },
      },
      checks: policy.requiredTargetChecks.map((id) => ({
        id,
        status: 'passed',
        evidenceSha256: hash(`target:${key}:${id}`),
      })),
    } satisfies FixtureTarget;
  });
  evidence.residualRisks = [];
  evidence.decision = {
    status: 'go',
    decidedAt: '2026-07-22T12:05:00.000Z',
    decidedBy: 'release-manager',
    rationale:
      'Every mandatory retained gate passed in this synthetic unit fixture.',
  };
  return evidence;
}

describe('release candidate validation', () => {
  it('retains an honest local no-go without disclosing risk descriptions', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const result = await evaluateCandidate(
      policy,
      await fixture(),
      COMMIT,
      ROOT,
    );
    expect(result.status).toBe('no-go');
    expect(result.targetsPassed).toBe(0);
    expect(result.failures).toContain('target_missing:windows/x64');
    expect(result.failures).toContain(
      'production_signature_missing:macos/arm64',
    );
    expect(JSON.stringify(result)).not.toContain('protected release-candidate');
  });

  it('accepts only a complete, production-signed matrix with retained checks', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const result = await evaluateCandidate(
      policy,
      await passingEvidence(),
      COMMIT,
      ROOT,
    );
    expect(result).toMatchObject({
      status: 'go',
      targetsPassed: 4,
      targetsRequired: 4,
      failures: [],
    });
  });

  it('detects source lock drift and contradictory decisions', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await passingEvidence();
    const firstLock = evidence.locks[0];
    if (!firstLock) throw new Error('missing test lock');
    evidence.locks[0] = { ...firstLock, sha256: hash('tampered') };
    const result = await evaluateCandidate(policy, evidence, COMMIT, ROOT);
    expect(result.failures).toContain(
      'lock_mismatch:apps/desktop/src-tauri/Cargo.lock',
    );
    expect(result.failures).toContain('decision_status_mismatch');
    expect(result.status).toBe('no-go');
  });

  it('never treats test signing material as production evidence', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await passingEvidence();
    const artifact = evidence.targets[0]?.artifact;
    if (!artifact) throw new Error('missing test artifact');
    artifact.detachedSignature.keyEnvironment = 'test';
    evidence.decision.status = 'no-go';
    evidence.decision.decidedBy = null;
    const result = await evaluateCandidate(policy, evidence, COMMIT, ROOT);
    expect(result.failures).toEqual(['production_signature_missing:linux/x64']);
  });

  it('rejects bundle-only package formats outside the supported desktop policy', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await passingEvidence();
    const linux = evidence.targets.find(
      (target) => target.platform === 'linux',
    );
    if (!linux?.artifact) throw new Error('missing Linux artifact');
    linux.artifact.name = 'NexaChat-0.1.0-beta-linux-x64.rpm';
    const result = await evaluateCandidate(policy, evidence, COMMIT, ROOT);
    expect(result.status).toBe('no-go');
    expect(result.failures).toContain('artifact_name_mismatch:linux/x64');
  });

  it('requires evidence for failed as well as passed checks', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await fixture();
    const first = evidence.globalChecks[0];
    if (!first) throw new Error('missing test check');
    first.status = 'failed';
    await expect(
      evaluateCandidate(policy, evidence, COMMIT, ROOT),
    ).rejects.toThrow('completed global checks needs retained evidence');
  });

  it('rejects malformed or overdue accepted-risk reviews', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await passingEvidence();
    evidence.residualRisks = [
      {
        id: 'accepted-risk',
        severity: 'low',
        status: 'accepted',
        owner: 'release-manager',
        reviewBy: '2026-02-30',
        summary: 'Synthetic risk.',
        mitigation: 'Synthetic mitigation.',
      },
    ];
    await expect(
      evaluateCandidate(policy, evidence, COMMIT, ROOT),
    ).rejects.toThrow('invalid risk review date');
  });

  it('rejects unknown evidence fields', async () => {
    const policy = await loadCandidatePolicy(ROOT);
    const evidence = await fixture();
    evidence.untrusted = true;
    await expect(
      evaluateCandidate(policy, evidence, COMMIT, ROOT),
    ).rejects.toThrow(CandidateValidationError);
  });
});
