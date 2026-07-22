import { createPostgresPool, planPostgresUpgrade } from '@nexa/postgres';
import { parseRuntimeConfig, safeConfigurationDiagnostic } from './config.js';

async function main(): Promise<number> {
  let config;
  try {
    config = parseRuntimeConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'upgrade.database_preflight', status: 'failed', ...safeConfigurationDiagnostic(error) })}\n`,
    );
    return 1;
  }

  const pool = createPostgresPool(config.database);
  try {
    const plan = await planPostgresUpgrade(
      pool,
      config.database.migrationsDirectory,
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'upgrade.database_preflight', status: 'ok', ...plan })}\n`,
    );
    return 0;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'upgrade.database_preflight', status: 'failed', code: 'database_preflight_failed' })}\n`,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
