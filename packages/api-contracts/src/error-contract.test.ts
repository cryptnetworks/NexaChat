import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { errorResponseSchema, pageQuerySchema } from './index.js';

describe('public API contract compatibility', () => {
  it('preserves the complete version-1 error envelope', () => {
    const fixture = {
      version: 1 as const,
      error: 'stale_write' as const,
      correlationId: randomUUID(),
      retryable: false,
    };
    expect(errorResponseSchema.parse(fixture)).toEqual(fixture);
    expect(
      errorResponseSchema.safeParse({ ...fixture, version: 2 }).success,
    ).toBe(false);
    expect(
      errorResponseSchema.safeParse({ ...fixture, error: 'stack_trace' })
        .success,
    ).toBe(false);
  });

  it('bounds page size and opaque cursor inputs', () => {
    const actorId = randomUUID();
    expect(pageQuerySchema.parse({ actorId })).toMatchObject({ limit: 50 });
    expect(pageQuerySchema.safeParse({ actorId, limit: 100 }).success).toBe(
      true,
    );
    expect(pageQuerySchema.safeParse({ actorId, limit: 101 }).success).toBe(
      false,
    );
    expect(
      pageQuerySchema.safeParse({ actorId, cursor: 'x'.repeat(257) }).success,
    ).toBe(false);
  });
});
