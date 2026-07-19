import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresPool, type PostgresConfig } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('PostgreSQL pool diagnostics', () => {
  it('handles idle-client errors without exposing connection details', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = createPostgresPool(config);
    const error = Object.assign(new Error('private database detail'), {
      code: '57P01',
    });

    pool.emit('error', error);

    expect(diagnostic).toHaveBeenCalledWith(
      JSON.stringify({ event: 'postgres.pool.error', code: '57P01' }),
    );
    expect(diagnostic.mock.calls.flat().join(' ')).not.toContain(
      'private database detail',
    );
    await pool.end();
  });
});

const config: PostgresConfig = {
  connectionString:
    'postgresql://private-user:private-password@127.0.0.1:1/nexa',
  maxConnections: 1,
  connectionTimeoutMs: 10,
  idleTimeoutMs: 10,
  queryTimeoutMs: 10,
  migrationsDirectory: '.',
};
