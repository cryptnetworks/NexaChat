import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPostgresPool,
  type PostgresConfig,
  type PostgresPoolObserver,
} from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PostgreSQL pool observer', () => {
  it('cannot change a successful query when the observer throws', async () => {
    const result = { rows: [{ value: 1 }], rowCount: 1 };
    const providerQuery = vi.fn().mockResolvedValue(result);
    const client = fakeClient(providerQuery);
    const event = vi.fn<PostgresPoolObserver['event']>(() => {
      throw new Error('telemetry unavailable');
    });
    const pool = createPostgresPool(config, { event });
    pool.emit('connect', client);

    await expect(
      client.query('SELECT $1::text', ['private-query-value']),
    ).resolves.toBe(result);

    expect(providerQuery).toHaveBeenCalledWith('SELECT $1::text', [
      'private-query-value',
    ]);
    expect(event).toHaveBeenLastCalledWith(
      'query',
      { total: 0, idle: 0, waiting: 0 },
      expect.any(Number),
    );
    await pool.end();
  });

  it('emits safe query and timeout outcomes with bounded pool snapshots and durations', async () => {
    const sql = 'SELECT $1::text AS private_value';
    const queryValue = 'private-query-value';
    const providerMessage = 'private provider failure detail';
    const result = { rows: [{ value: queryValue }], rowCount: 1 };
    const timeout = Object.assign(new Error(providerMessage), {
      code: '57014',
    });
    const providerQuery = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(timeout);
    const client = fakeClient(providerQuery);
    const event = vi.fn<PostgresPoolObserver['event']>();
    const pool = createPostgresPool(config, { event });
    pool.emit('connect', client);

    await expect(client.query(sql, [queryValue])).resolves.toBe(result);
    await expect(client.query(sql, [queryValue])).rejects.toBe(timeout);

    expect(event.mock.calls.map(([name]) => name)).toEqual([
      'connect',
      'query',
      'timeout',
    ]);
    for (const [, snapshot, durationMs] of event.mock.calls.slice(1)) {
      expect(snapshot).toEqual({ total: 0, idle: 0, waiting: 0 });
      expect(durationMs).toBeTypeOf('number');
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }
    const payload = JSON.stringify(event.mock.calls);
    for (const secret of [
      sql,
      queryValue,
      providerMessage,
      config.connectionString,
      'private-user',
      'private-password',
    ])
      expect(payload).not.toContain(secret);
    await pool.end();
  });

  it('observes callback queries exactly once without SQL, values, or error detail', async () => {
    const sql = 'SELECT $1::text AS private_callback_value';
    const queryValue = 'private-callback-query-value';
    const result = { rows: [{ value: queryValue }], rowCount: 1 };
    const queryFailure = Object.assign(
      new Error('private callback query failure'),
      { code: '23505' },
    );
    const timeout = Object.assign(new Error('private callback timeout'), {
      code: '57014',
    });
    const outcomes = [
      { error: null, result },
      { error: queryFailure },
      { error: timeout },
    ];
    const providerQuery = vi.fn(
      (
        _text: string,
        _values: unknown[],
        callback: (error: Error | null, value?: unknown) => void,
      ) => {
        const outcome = outcomes.shift();
        if (!outcome) throw new Error('unexpected callback query');
        callback(outcome.error, outcome.result);
      },
    );
    const client = fakeClient(providerQuery);
    const event = vi.fn<PostgresPoolObserver['event']>();
    const pool = createPostgresPool(config, { event });
    pool.emit('connect', client);

    await expect(callbackQuery(client, sql, [queryValue])).resolves.toBe(
      result,
    );
    await expect(callbackQuery(client, sql, [queryValue])).rejects.toBe(
      queryFailure,
    );
    await expect(callbackQuery(client, sql, [queryValue])).rejects.toBe(
      timeout,
    );

    expect(providerQuery).toHaveBeenCalledTimes(3);
    expect(event.mock.calls.map(([name]) => name)).toEqual([
      'connect',
      'query',
      'query_error',
      'timeout',
    ]);
    for (const [, snapshot, durationMs] of event.mock.calls.slice(1)) {
      expect(snapshot).toEqual({ total: 0, idle: 0, waiting: 0 });
      expect(durationMs).toBeTypeOf('number');
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }
    const observed = JSON.stringify(event.mock.calls);
    for (const privateValue of [
      sql,
      queryValue,
      queryFailure.message,
      timeout.message,
      config.connectionString,
    ])
      expect(observed).not.toContain(privateValue);
    await pool.end();
  });

  it('isolates observer exceptions from pool error events', async () => {
    const providerMessage = 'private pool failure detail';
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = vi.fn<PostgresPoolObserver['event']>(() => {
      throw new Error('telemetry unavailable');
    });
    const pool = createPostgresPool(config, { event });

    expect(() =>
      pool.emit(
        'error',
        Object.assign(new Error(providerMessage), { code: '57P01' }),
      ),
    ).not.toThrow();

    expect(event).toHaveBeenCalledWith(
      'pool_error',
      {
        total: 0,
        idle: 0,
        waiting: 0,
      },
      undefined,
    );
    const payload = JSON.stringify(event.mock.calls);
    expect(payload).not.toContain(providerMessage);
    expect(payload).not.toContain(config.connectionString);
    expect(diagnostic).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'postgres.pool.error',
        code: 'pool_error',
      }),
    );
    await pool.end();
  });

  it('distinguishes query failures from pool failures when diagnostics throw', async () => {
    const queryFailure = Object.assign(new Error('private query detail'), {
      code: '23505',
    });
    const poolFailure = new Error('private pool detail');
    const providerQuery = vi.fn().mockRejectedValue(queryFailure);
    const client = fakeClient(providerQuery);
    const event = vi.fn<PostgresPoolObserver['event']>();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('diagnostic sink unavailable');
    });
    const pool = createPostgresPool(config, { event });
    pool.emit('connect', client);

    await expect(client.query('SELECT private_query')).rejects.toBe(
      queryFailure,
    );
    expect(() => pool.emit('error', poolFailure)).not.toThrow();

    expect(event.mock.calls.map(([name]) => name)).toEqual([
      'connect',
      'query_error',
      'pool_error',
    ]);
    expect(diagnostic).toHaveBeenCalledOnce();
    const observed = JSON.stringify(event.mock.calls);
    expect(observed).not.toContain('private query detail');
    expect(observed).not.toContain('private pool detail');
    await pool.end();
  });
});

function fakeClient(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query } as unknown as PoolClient;
}

function callbackQuery(
  client: PoolClient,
  sql: string,
  values: unknown[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const query = client.query.bind(client) as unknown as (
      text: string,
      parameters: unknown[],
      callback: (error: Error | null, result?: unknown) => void,
    ) => void;
    query(sql, values, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

const config: PostgresConfig = {
  connectionString:
    'postgresql://private-user:private-password@private-endpoint.example.test:5432/nexa',
  maxConnections: 5,
  connectionTimeoutMs: 100,
  idleTimeoutMs: 1_000,
  queryTimeoutMs: 100,
  migrationsDirectory: '.',
};
