import { createPostgresPool, migratePostgres } from '@nexa/postgres';
import { parseRuntimeConfig, safeConfigurationDiagnostic } from './config.js';

async function run(): Promise<void> {
  let config;
  try {
    config = parseRuntimeConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'configuration.invalid', ...safeConfigurationDiagnostic(error) })}\n`,
    );
    throw error;
  }
  const pool = createPostgresPool(config.database);
  try {
    const version = await migratePostgres(
      pool,
      config.database.migrationsDirectory,
      (migration) => {
        process.stdout.write(
          `${JSON.stringify({ event: 'migration.applied', ...migration })}\n`,
        );
      },
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'migration.complete', schemaVersion: version })}\n`,
    );
  } finally {
    await pool.end();
  }
}

try {
  await run();
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: 'migration.failed', code: 'migration_failed' })}\n`,
  );
  process.exitCode = 1;
}
