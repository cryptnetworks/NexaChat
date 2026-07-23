import { describe, expect, it } from 'vitest';
import { bundleBudget, evaluateBundle } from './bundle-budget.js';

const passing = {
  javascriptBytes: 280_000,
  javascriptGzipBytes: 80_000,
  cssBytes: 4_500,
  cssGzipBytes: 1_700,
  totalAssetBytes: 285_000,
  largestJavascriptChunkBytes: 280_000,
  javascriptChunks: 1,
  cssChunks: 1,
};

describe('web bundle budget', () => {
  it('accepts the documented production envelope', () => {
    expect(evaluateBundle(passing)).toMatchObject({
      passed: true,
      failures: [],
    });
  });

  it('rejects absolute and baseline regressions independently', () => {
    const absolute = evaluateBundle({
      ...passing,
      javascriptBytes: bundleBudget.maxJavascriptBytes + 1,
    });
    expect(absolute.failures).toContain('javascript_bytes_exceeded');
    const regression = evaluateBundle(
      { ...passing, javascriptGzipBytes: 90_000 },
      passing,
    );
    expect(regression.failures).toContain(
      'javascriptGzipBytes_regression_exceeded',
    );
  });
});
