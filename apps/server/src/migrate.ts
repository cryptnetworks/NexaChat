import { createPostgresPool, migratePostgres } from '@nexa/postgres';
import { parseMigrationConfig, safeConfigurationDiagnostic } from './config.js';
import { loadFileBackedSecrets } from './secrets.js';

async function run(): Promise<void> {
  let config;
  try {
    config = parseMigrationConfig(loadFileBackedSecrets(process.env));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'configuration.invalid', ...safeConfigurationDiagnostic(error) })}\n`,
    );
    throw error;
  }
  const pool = createPostgresPool(config);
  try {
    const version = await migratePostgres(
      pool,
      config.migrationsDirectory,
      (migration) => {
        process.stdout.write(
          `${JSON.stringify({ event: 'migration.applied', ...migration })}\n`,
        );
      },
    );
    await pool.query(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexa_app') THEN
           REVOKE INSERT, UPDATE, DELETE, TRUNCATE
           ON TABLE nexa_schema_migrations FROM nexa_app;
         END IF;
       END $$`,
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
