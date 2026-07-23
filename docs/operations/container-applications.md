# Server and web containers

NexaChat provides separate production images for the API server and the web
application, plus one shared development image for live-reload work. The
single-host production topology remains the hardened deployment described in
[Single-host production deployment](production-deployment.md). This guide
defines image responsibilities, containerized development, configuration, and
the verification boundary shared by both models.

## Architecture and responsibilities

```text
browser
  |
  v
web/edge :8443 (only published production port)
  |-- fingerprinted static web assets
  |-- /v1/* HTTP proxy
  |-- /v1/realtime WebSocket proxy
  |-- /health/* bounded probe proxy
  v
server :3000
  |-- PostgreSQL :5432 (authoritative)
  |-- Valkey :6379 (coordination)
  `-- S3-compatible storage :8333 (objects)
```

| Image target          | Responsibility                                      | Runtime user | Internal ports |
| --------------------- | --------------------------------------------------- | ------------ | -------------- |
| `server-runtime`      | API, WebSocket, health, metrics, and migrations      | `node`       | 3000           |
| `web-runtime`         | Static web assets, HTTPS, HTTP proxy, and WSS proxy  | `nginx`      | 8443           |
| `edge-runtime`        | Compatibility alias for `web-runtime`               | `nginx`      | 8443           |
| `development-runtime` | Server and web toolchain used by two isolated tasks | `node`       | 3000, 5173     |

The production Compose service remains named `edge` for deployment
compatibility, while it builds the explicit `web-runtime` target. The web image
never contains server credentials. The server image contains no static web
toolchain, application source tree, npm executable, or development dependency
set. Both application images include the repository license and notice.

PostgreSQL, Valkey, and object storage attach only to the internal production
backend network. The server joins the backend and frontend networks. The web
service joins only the frontend network and overwrites forwarding headers before
proxying. Do not attach unrelated containers to either network.

## Toolchain and immutable inputs

The pins below are the merged, scanned deployment baseline. Runtime status was
reviewed on 2026-07-22 against the upstream Node.js release schedule,
PostgreSQL versioning policy, Valkey release list, nginx downloads, Docker
Compose merge reference, and the repository security policy. Patch updates use
the procedure in [Supply-chain and security verification](supply-chain-security.md);
they are not mixed into application-container changes.

| Component            | Reviewed pin or requirement                                      | Selection reason |
| -------------------- | ---------------------------------------------------------------- | ---------------- |
| Dockerfile frontend  | `docker/dockerfile:1.7` by SHA-256 digest                         | Stable declared syntax with immutable resolution |
| Node.js              | 24.18.0 Alpine 3.23 by multi-platform digest                      | Repository-supported LTS runtime |
| npm                  | 11.16.0 from the Node image and root lockfile                     | Exact frozen workspace install |
| PostgreSQL           | 17.9 Alpine 3.23 by digest                                        | Supported major and verified migration/restore baseline |
| Valkey               | 8.1.8 Alpine 3.23 by digest                                       | Supported 8.1 line and verified coordination baseline |
| Object storage       | SeaweedFS 4.40 runtime by digest                                  | Verified S3 adapter baseline |
| Object build         | Go 1.25.12 plus gRPC-Go 1.82.1 with source and module checksums   | Reproducible patched binary |
| Web server           | nginx 1.31.3 Alpine 3.24 by digest                                | Minimal non-root static/proxy runtime |
| Docker Compose       | 2.24.4 or newer                                                   | Required for the reviewed `!reset` override semantics |
| GitHub Actions       | Checkout, Node setup, and artifact upload v7 by commit SHA        | Immutable supported workflow actions |

Use a maintained Docker Engine with BuildKit and the Compose plugin. The legacy
standalone `docker-compose` executable is not supported. Confirm prerequisites:

```sh
docker version
docker compose version
docker buildx version
```

## Production builds

Build the application images from committed inputs and the root lockfile:

```sh
revision="$(git rev-parse HEAD)"
docker build --pull --target server-runtime \
  --build-arg NEXA_IMAGE_REVISION="$revision" \
  --build-arg NEXA_IMAGE_VERSION=local-verification \
  --tag nexa-chat-server:local-verification .
docker build --pull --target web-runtime \
  --build-arg NEXA_IMAGE_REVISION="$revision" \
  --build-arg NEXA_IMAGE_VERSION=local-verification \
  --tag nexa-chat-web:local-verification .
```

The builder installs dependencies with `npm ci --ignore-scripts`. The server
runtime performs a second frozen production-only install from
`apps/server/runtime/package-lock.json`. The web runtime receives only the Vite
production output. Build arguments set public OCI source, revision, and version
metadata; they must never contain secrets.

BuildKit cache reuse is safe for public package downloads but must not be used
for secret material. A build must succeed from a clean checkout without `.env`,
certificates, credentials, or untracked configuration. `.dockerignore` excludes
dependency directories, generated output, reports, local caches, environment
files, key material, local databases, backups, logs, and documentation that no
image consumes.

## Containerized development

The base `docker-compose.yml` continues to support providers for host-run
development. Provider ports now bind to `127.0.0.1` by default. Add the
development model to run the server and web application in containers:

```sh
docker compose -f docker-compose.yml -f compose.development.yml \
  --profile applications config --quiet
npm run dev:containers
```

Open `http://localhost:5173`. The Vite service proxies `/v1`, `/health`, and
WebSocket upgrades to `server:3000`. The application profile removes all
provider host ports; only loopback server and web ports remain. The services run
as UID/GID 1000, drop capabilities, prevent privilege escalation, use read-only
root filesystems, and write bounded temporary data under `/tmp`.

Source mounts are intentionally narrow and read-only. Container-installed
`node_modules` remain inside the image, so host binaries cannot mask Linux
dependencies on macOS or Windows. Source, configuration, and translation edits
reload automatically. Rebuild after changing a package manifest or lockfile:

```sh
docker compose -f docker-compose.yml -f compose.development.yml \
  --profile applications build --no-cache server web
```

Stop the applications and providers without deleting durable development data:

```sh
npm run dev:containers:down
```

To run only providers for host Node processes, continue using `npm run dev:up`
or `docker compose up --detach --wait` as documented in
[Development and operations](development.md).

## Configuration matrix

Secrets are file-backed in production and are never valid in image arguments,
labels, or client-side configuration. “Required” below means Compose rejects a
production render without the value. Defaults are development or safe operator
defaults, not permission to skip review.

| Variable | Service | Required | Secret | Default | Validation | Production guidance |
| --- | --- | ---: | ---: | --- | --- | --- |
| `NEXA_COMPOSE_PROJECT_NAME` | all production | no | no | `nexa-chat-production` | Compose name | Use one stable host-local name |
| `NEXA_SECRET_DIR` | all production | yes | no | none | absolute readable directory | Root-owned `0700`; files are `0444` for isolated UIDs |
| `NEXA_PUBLIC_ORIGIN` | server, web | yes | no | none | exact HTTPS origin, non-local host | Match public DNS and certificate SAN |
| `NEXA_HTTPS_BIND_ADDRESS` | web | no | no | `0.0.0.0` | valid host bind address | Restrict with host firewall or tunnel profile |
| `NEXA_HTTPS_PORT` | web | no | no | `443` | valid published port | Publish only this application port |
| `NEXA_FRONTEND_SUBNET` | server, web | no | no | `172.30.0.0/24` | valid non-overlapping CIDR | Reserve a private host subnet |
| `NEXA_BACKEND_SUBNET` | server, providers | no | no | `172.31.0.0/24` | valid non-overlapping CIDR | Keep internal and unattached to unrelated services |
| `NEXA_EDGE_ADDRESS` | web, server trust | no | no | `172.30.0.10` | usable frontend IPv4 | Must match the server’s trusted proxy `/32` |
| `NEXA_SERVER_ADDRESS` | server | no | no | `172.30.0.11` | distinct usable frontend IPv4 | Keep stable across recreations |
| `NEXA_IMAGE_TAG` | custom production images | yes | no | none | non-empty immutable release identifier | Never use `latest`, `local`, or a moving branch |
| `NEXA_IMAGE_VERSION` | custom production images | yes | no | none | non-empty OCI version | Use the reviewed application version |
| `NEXA_IMAGE_REVISION` | custom production images | yes | no | none | full deployed commit in release process | Record the exact source commit |
| `NEXA_IMAGE_SOURCE` | custom production images | no | no | repository URL | public URL | Keep the canonical source repository |
| `NEXA_SERVER_IMAGE` | server, migrate | no | no | `nexa-chat-server` | image reference | Override only with a verified private registry path |
| `NEXA_EDGE_IMAGE` | web | no | no | `nexa-chat-edge` | image reference | Compatibility name for the `web-runtime` artifact |
| `NEXA_POSTGRES_IMAGE` | PostgreSQL | no | no | `nexa-chat-postgres` | image reference | Use the verified patched target |
| `NEXA_OBJECT_STORAGE_IMAGE` | object storage | no | no | `nexa-chat-object-storage` | image reference | Use the verified source-built target |
| `NEXA_BACKUP_IMAGE` | backup job | no | no | `nexa-chat-backup` | image reference | Keep revision aligned with server migrations |
| `NEXA_LOG_LEVEL` | server | no | no | `info` | `debug`, `info`, `warn`, or `error` | Avoid debug outside a bounded incident window |
| `NEXA_TRACE_SAMPLE_RATE` | server | no | no | `0.01` | decimal from 0 through 1 | Size for traffic while preserving privacy bounds |
| `NEXA_S3_BUCKET` | server, storage, backup | no | no | `nexa-attachments` | lowercase S3 bucket, 3–63 characters | Use one private bucket per deployment |
| `NEXA_S3_REGION` | server, backup | no | no | `us-east-1` | non-empty region | Match the selected S3 provider behavior |
| `NEXA_BACKUP_DIR` | backup job | no | no | `/srv/nexa-chat/backups` | host bind path | Use encrypted durable storage off the application volume |
| `NEXA_BACKUP_UID` / `NEXA_BACKUP_GID` | backup job | no | no | `1000` / `1000` | numeric IDs | Match ownership of the backup destination |
| `NEXA_BACKUP_KEY_ID` | backup job | no | no | `operator-managed` | non-secret identifier | Identify the separately stored encryption key |
| `NEXA_BACKUP_RETENTION_DAYS` | backup job | no | no | `30` | bounded positive integer | Align with legal and recovery policy |
| `NEXA_BACKUP_RETENTION_COUNT` | backup job | no | no | `7` | bounded positive integer | Retain several independently restorable generations |
| `NEXA_BACKUP_INCOMPLETE_HOURS` | backup job | no | no | `24` | bounded positive integer | Remove only expired incomplete checkpoints |
| `NEXA_BACKUP_MAX_OBJECT_BYTES` | backup job | no | no | `67108864` | bounded byte count | Raise only after streaming and capacity review |
| `NEXA_BACKUP_MODE` | backup job | no | no | none | supported operation choice | Set only for an explicit operations invocation |
| `NEXA_RECOVERY_MODE` | backup job | no | no | none | supported recovery choice | Use only in an isolated recovery procedure |
| `NEXA_RECOVERY_ALLOW_COMPATIBLE_REVISION` | backup job | no | no | unset | strict boolean | Enable only with documented compatibility evidence |
| `NEXA_DEVELOPMENT_PROJECT_NAME` | development | no | no | `nexa-chat-development` | Compose name | Change to isolate simultaneous checkouts |
| `NEXA_DEVELOPMENT_IMAGE_TAG` | development | no | no | `local` | local tag | Not a production release identifier |
| `NEXA_DEVELOPMENT_BIND_ADDRESS` | development | no | no | `127.0.0.1` | valid host bind address | Do not use `0.0.0.0` on an untrusted network |
| `NEXA_DEVELOPMENT_SERVER_PORT` | development server | no | no | `3000` | valid host port | Loopback debugging only |
| `NEXA_DEVELOPMENT_WEB_PORT` | development web | no | no | `5173` | valid host port and trusted origin | Access with the exact `localhost` origin |
| `POSTGRES_PUBLISHED_PORT` | standalone development provider | no | no | `5432` | valid host port | Loopback only; removed in the application profile |
| `VALKEY_PUBLISHED_PORT` | standalone development provider | no | no | `6379` | valid host port | Loopback only; removed in the application profile |
| `S3_PUBLISHED_PORT` | standalone development provider | no | no | `8333` | valid host port | Loopback only; removed in the application profile |

The required production secret files and rotation procedure are maintained in
the [production deployment guide](production-deployment.md#secrets). They
include database and Valkey passwords plus matching URLs, bucket-scoped S3
credentials, TLS certificate/key files, and the backup encryption key. The
server receives only `_FILE` paths. Browser assets never receive these values.

## Health, startup, migration, and shutdown

The server image liveness check calls `/health/live`. Compose traffic readiness
calls `/health/ready`; startup state is available at `/health/startup`.
Readiness becomes unavailable before graceful drain and does not become ready
until required initialization and the schema check complete. Optional Valkey or
storage loss produces documented degradation without turning liveness into a
dependency test.

Production uses one `migrate` service from the exact server image. It waits for
provider health, applies ordered migrations under PostgreSQL advisory locking,
and must complete successfully before the server starts. Replicas do not race
startup migration. Migration failure leaves the application unready; do not
bypass the completion condition or edit applied migration history.

The server receives `SIGTERM`, rejects new work, marks readiness unavailable,
drains admitted HTTP and WebSocket work, and closes providers within its bounded
deadline. Nginx receives `SIGQUIT`. Compose allows a slightly longer grace
period before forced termination.

## Static assets, proxying, and runtime security

The web image serves same-origin assets with correct MIME types, disables
directory listing and server tokens, applies CSP and browser security headers,
does not expose source maps by default, and avoids long-lived caching of
`index.html`. Fingerprinted assets use the immutable Vite naming model. SPA
fallback applies only to the application route; `/v1`, `/health`, and the
internal `/metrics` denial have explicit locations.

The proxy overwrites host, protocol, port, forwarding, and real-address headers.
Only the fixed web address is trusted by the server. WebSocket upgrade headers
are set only on `/v1/realtime`. Request bodies, headers, connection timeouts,
upstream timeouts, temporary storage, processes, memory, and logs are bounded.
The web root and server application filesystem are read-only in production.

Logs go to standard output/error with rotation in Compose. They exclude request
URIs, client addresses, credentials, sessions, message content, and signed
object data. Metrics remain on the private server network and use bounded label
sets. The public web service returns `404` for `/metrics`.

## Scaling and platforms

The production reference is one host and one server replica. PostgreSQL is
authoritative; Valkey supplies shared coordination. Multiple replicas require
the stateless application profile, shared rate limits and fan-out, safe job
ownership, connection draining, and rolling-compatibility evidence. Do not scale
the single-host example by copying the server service without those controls.

The Dockerfile avoids host-architecture assumptions and the object binary uses
BuildKit `BUILDPLATFORM`, `TARGETOS`, and `TARGETARCH`. Base images publish
`linux/amd64` and `linux/arm64` variants. Only `linux/amd64` is currently a
supported server candidate because that is the retained end-to-end production
evidence. `linux/arm64` is an evaluated build target, not a support claim, until
native build, runtime, migration, recovery, load, and scan evidence is retained.
Desktop macOS/Windows packaging is outside the Linux container boundary.

## Verification and retained evidence

Fast policy and model checks:

```sh
npm run verify:container-policy
docker compose config --quiet
docker compose -f docker-compose.yml -f compose.development.yml \
  --profile applications config --quiet
NEXA_SECRET_DIR=/tmp/nexa-chat-secrets \
NEXA_PUBLIC_ORIGIN=https://chat.example.test \
NEXA_IMAGE_TAG=verification \
NEXA_IMAGE_VERSION=verification \
NEXA_IMAGE_REVISION="$(git rev-parse HEAD)" \
  docker compose -f compose.production.yml config --quiet
```

The development integration test creates one unique project, builds the shared
image, starts clean providers and both applications, verifies loopback/private
ports, non-root/read-only execution, authenticated HTTP and WebSocket proxying,
graceful shutdown, restart persistence, redacted logs, and project-scoped
cleanup:

```sh
npm run verify:development-containers
```

The path-filtered `Container application verification` workflow builds the
server and web production targets, validates BuildKit metadata, records local
image IDs and uncompressed sizes, checks image contents, scans every HIGH and
CRITICAL result, generates CycloneDX SBOMs, and runs the development topology.
Evidence is retained for 30 days under an artifact tied to the exact commit.
The default-branch supply-chain workflow remains authoritative for the complete
PostgreSQL, backup, server, web/edge, object-storage, and Valkey image set.

For the full HTTPS/WSS, private-network, migration, provider persistence,
graceful restart, secret, image-scan, and SBOM test, run:

```sh
NEXA_VERIFY_SCAN=1 bash scripts/verify-production.sh
```

## Cleanup and recovery

Normal development shutdown preserves named volumes:

```sh
npm run dev:containers:down
```

**Warning: the next command permanently deletes PostgreSQL, Valkey, and object
storage data for the selected development project. Verify the project name and
back up anything needed before running it.**

```sh
docker compose -f docker-compose.yml -f compose.development.yml \
  --profile applications down --volumes --remove-orphans
```

Never run `down --volumes` against production. Follow the encrypted backup,
isolated restore, upgrade, and rollback procedures in the production and
backup guides. A previous application image is a valid rollback only when it is
compatible with the already-applied forward-only schema.
