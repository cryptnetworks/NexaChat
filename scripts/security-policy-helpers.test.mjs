import { describe, expect, it } from 'vitest';
import {
  hasCompleteSqlStatement,
  isApprovedLicenseExpression,
} from './security-policy-helpers.mjs';

describe('security policy helpers', () => {
  const allowed = new Set(['Apache-2.0', 'MIT']);

  it('accepts reviewed licenses and alternatives only', () => {
    expect(isApprovedLicenseExpression('MIT', allowed)).toBe(true);
    expect(isApprovedLicenseExpression('Apache-2.0 OR MIT', allowed)).toBe(
      true,
    );
    expect(isApprovedLicenseExpression('MIT OR GPL-2.0-only', allowed)).toBe(
      false,
    );
    expect(isApprovedLicenseExpression('Apache-2.0 AND MIT', allowed)).toBe(
      false,
    );
    expect(isApprovedLicenseExpression(undefined, allowed)).toBe(false);
  });

  it('accepts complete SQL followed by comments', () => {
    expect(hasCompleteSqlStatement('SELECT 1; -- retained rationale\n')).toBe(
      true,
    );
    expect(
      hasCompleteSqlStatement('SELECT 1; /* retained\n rationale */\n'),
    ).toBe(true);
    expect(hasCompleteSqlStatement("SELECT '-- not a comment';\n")).toBe(true);
    expect(
      hasCompleteSqlStatement("DO $$ BEGIN RAISE NOTICE ';'; END $$; -- ok"),
    ).toBe(true);
  });

  it('rejects incomplete SQL and unterminated constructs', () => {
    expect(hasCompleteSqlStatement('SELECT 1 -- no terminator')).toBe(false);
    expect(hasCompleteSqlStatement('SELECT 1; /* unfinished')).toBe(false);
    expect(hasCompleteSqlStatement("SELECT 'unfinished;")).toBe(false);
    expect(hasCompleteSqlStatement('DO $$ BEGIN;')).toBe(false);
  });
});
