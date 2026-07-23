import { readFile } from 'node:fs/promises';

const [dockerfile, development, providers, production, vite, workflow, runbook] =
  await Promise.all([
    readFile('Dockerfile', 'utf8'),
    readFile('compose.development.yml', 'utf8'),
    readFile('docker-compose.yml', 'utf8'),
    readFile('compose.production.yml', 'utf8'),
    readFile('apps/web/vite.config.ts', 'utf8'),
    readFile('.github/workflows/container-verification.yml', 'utf8'),
    readFile('docs/operations/container-applications.md', 'utf8'),
  ]);

const failures = [];
const requireText = (source, values, label) => {
  for (const value of values)
    if (!source.includes(value)) failures.push(`${label} lacks ${value}`);
};

requireText(
  dockerfile,
  [
    'AS development-runtime',
    'USER node',
    'EXPOSE 3000 5173',
    'FROM edge-runtime AS web-runtime',
    'LICENSE NOTICE /usr/share/licenses/nexa-chat/',
  ],
  'Dockerfile',
);
if (
  [...dockerfile.matchAll(/LICENSE NOTICE \/usr\/share\/licenses\/nexa-chat\//gu)]
    .length !== 2
)
  failures.push('application runtime images must contain license files');

requireText(
  development,
  [
    'profiles: [applications]',
    "user: '1000:1000'",
    'read_only: true',
    'cap_drop: [ALL]',
    'security_opt: [no-new-privileges:true]',
    'target: development-runtime',
    'NEXA_DEV_PROXY_TARGET: http://server:3000',
    'condition: service_healthy',
    "host_ip: '${NEXA_DEVELOPMENT_BIND_ADDRESS:-127.0.0.1}'",
  ],
  'development Compose model',
);
if ([...development.matchAll(/^\s+ports: !reset \[\]$/gmu)].length !== 3)
  failures.push('application development profile must unpublish all providers');
if ([...development.matchAll(/^\s+read_only: true$/gmu)].length < 11)
  failures.push('development source mounts must be read-only');
if (/source:\s+.*node_modules/iu.test(development))
  failures.push('development profile mounts host dependency directories');

if (
  [
    ...providers.matchAll(
      /^\s+host_ip: '\$\{NEXA_DEVELOPMENT_BIND_ADDRESS:-127\.0\.0\.1\}'$/gmu,
    ),
  ].length !== 3
)
  failures.push('standalone development providers must default to loopback');

requireText(
  production,
  [
    'target: web-runtime',
    'target: server-runtime',
    'internal: true',
    'DATABASE_URL_FILE: /run/secrets/database_url',
  ],
  'production Compose model',
);
requireText(
  vite,
  [
    "process.env.NEXA_DEV_PROXY_TARGET ?? 'http://localhost:3000'",
    'NEXA_DEV_PROXY_TARGET must be an HTTP origin',
    "'/v1': { target: proxyTarget, ws: true }",
  ],
  'web development proxy',
);
requireText(
  workflow,
  [
    'permissions:',
    'contents: read',
    'timeout-minutes:',
    'scripts/verify-development-containers.sh',
    'scripts/scan-production-images.sh',
    'persist-credentials: false',
  ],
  'container verification workflow',
);
requireText(
  runbook,
  [
    '| Variable | Service | Required | Secret | Default | Validation | Production guidance |',
    'docker compose -f docker-compose.yml -f compose.development.yml',
    'server-runtime',
    'web-runtime',
    'linux/amd64',
    'linux/arm64',
  ],
  'container application runbook',
);

if (failures.length) {
  for (const failure of failures)
    console.error(`container_policy_error: ${failure}`);
  process.exit(1);
}

console.log(
  'Container application policy verified: distinct production images, bounded development services, private providers, immutable inputs, and documented operations.',
);
