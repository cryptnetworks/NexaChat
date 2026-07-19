import {
  createPostgresPool,
  migratePostgres,
  postgresConfigFromEnvironment,
} from '@nexa/postgres';

const config = postgresConfigFromEnvironment();
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
  process.stdout.write(
    `${JSON.stringify({ event: 'migration.complete', schemaVersion: version })}\n`,
  );
} finally {
  await pool.end();
}
