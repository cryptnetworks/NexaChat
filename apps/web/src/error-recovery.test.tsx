import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlobalErrorBoundary, safeClientError } from './error-recovery.js';

describe('global error recovery', () => {
  it('redacts unsafe diagnostics and renders accessible recovery with draft preservation', () => {
    expect(
      safeClientError({
        code: '<secret>',
        correlationId: 'short',
        body: 'private',
      }),
    ).toEqual({
      code: 'unexpected_error',
      correlationId: null,
      recoverable: true,
    });
    const boundary = new GlobalErrorBoundary({ children: null });
    boundary.state = {
      error: {
        code: 'failed',
        correlationId: '12345678-abcd',
        recoverable: true,
      },
    };
    const markup = renderToStaticMarkup(boundary.render());
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('unsent text is still saved');
    expect(markup).toContain('12345678-abcd');
    expect(markup).not.toContain('private');
  });
});
