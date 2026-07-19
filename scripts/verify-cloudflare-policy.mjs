import { readFile } from 'node:fs/promises';

const [compose, dockerfile, nginx, proxy, runbook, workflow] =
  await Promise.all([
    readFile('compose.cloudflare-tunnel.yml', 'utf8'),
    readFile('Dockerfile', 'utf8'),
    readFile('deploy/nginx-cloudflare/nginx.conf', 'utf8'),
    readFile('deploy/nginx/nexa-proxy.conf', 'utf8'),
    readFile('docs/operations/cloudflare-tunnel.md', 'utf8'),
    readFile('.github/workflows/verify.yml', 'utf8'),
  ]);

const failures = [];
const requireText = (source, values, label) => {
  for (const value of values)
    if (!source.includes(value)) failures.push(`${label} lacks ${value}`);
};

requireText(
  compose,
  [
    'cloudflare/cloudflared:2026.7.2@sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d',
    'cloudflared-a:',
    'cloudflared-b:',
    "user: '65532:65532'",
    'read_only: true',
    'cap_drop: [ALL]',
    'no-new-privileges:true',
    'ports: !reset []',
    '--token-file',
    '/run/secrets/cloudflare_tunnel_token',
    'tunnel_origin_ca',
    'cloudflared,',
    'ready,',
    'stop_grace_period: 30s',
    'subnet: 172.29.0.0/29',
  ],
  'Compose profile',
);
if (/TUNNEL_TOKEN\s*:/u.test(compose))
  failures.push('Compose profile injects the tunnel token through environment');
requireText(
  dockerfile,
  [
    'FROM edge-runtime AS edge-cloudflare-runtime',
    'deploy/nginx-cloudflare/nginx.conf',
  ],
  'Dockerfile',
);
requireText(
  `${nginx}\n${proxy}`,
  [
    'set_real_ip_from 172.29.0.2;',
    'set_real_ip_from 172.29.0.3;',
    'real_ip_header CF-Connecting-IP;',
    'if ($nexa_tunnel_request = 0)',
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'location = /v1/realtime',
    'proxy_set_header Upgrade $http_upgrade;',
    'location /v1/',
    'try_files $uri $uri/ /index.html;',
  ],
  'tunnel edge',
);
requireText(
  runbook,
  [
    'Prerequisite evidence',
    'Published route',
    'originServerName',
    'caPool',
    'Cloudflare Access',
    'Multiple connectors',
    'Rotate and revoke',
    'Failure recovery',
    'DNS, TLS, and firewall',
    'Smoke verification',
    'Remove the tunnel',
    '7844',
  ],
  'runbook',
);
if (!workflow.includes('npm run verify:cloudflare-policy'))
  failures.push('CI does not enforce the tunnel deployment policy');

if (failures.length) {
  for (const failure of failures)
    console.error(`cloudflare_policy_error: ${failure}`);
  process.exit(1);
}

console.log(
  'Cloudflare Tunnel policy verified: immutable connectors, private origin, strict proxy boundary, token file, HA, and lifecycle guidance.',
);
