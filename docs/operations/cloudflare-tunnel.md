# Cloudflare Tunnel deployment

This optional profile publishes the existing hardened production edge through two outbound-only `cloudflared` connectors. It does not replace application authentication, authorization, CSRF/origin validation, rate limits, encrypted backups, or the production TLS boundary. Never put a real tunnel token, account identifier, tunnel UUID, public hostname, Access assertion, or private origin name in source control, Compose arguments, logs, screenshots, or issue evidence.

## Prerequisite evidence

The feature stack contains the verified work for issue #14 at `68baa4d` (attachment threat model), #16 at `47c41fd` (production telemetry/health), #18 at `8ac661d` (hardened deployment), and the reconciled #21 configuration commits `13a97b6` and `70f5212`. Before each deployment, rerun the repository verification against the exact candidate revision. A branch name or an earlier green result is not release evidence.

## Secrets and immutable images

Create the production secret directory outside the checkout with mode `0700`. Create `cloudflare_tunnel_token` with mode `0400` or `0440`, owned so Docker can mount it read-only. Put only the remotely managed tunnel token in that file, with one trailing newline permitted. The profile passes its path through `--token-file`; it never injects the token into an environment variable or command argument.

Create a private origin CA and an edge certificate for the exact public hostname. Store the CA certificate as `tunnel_origin_ca.pem`; configure the existing `tls_cert.pem` and `tls_key.pem` as a leaf certificate and key signed by that CA. Keep the CA private key offline. The connector receives only the public CA certificate. Do not enable `noTLSVerify`.

`cloudflared` is pinned to version `2026.7.2` and multi-platform manifest digest `sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d`. Upgrades require release-note review, digest resolution from the official image, SBOM/container scanning, smoke verification, and a focused change. Autoupdate is disabled so running bytes cannot drift from review evidence.

## Published route

Create one remotely managed public-hostname route for the application hostname. Route the entire hostname to `https://edge:8443` when configuring through the connector's tunnel network alias. Configure these origin parameters:

- `originServerName`: the exact public application hostname;
- `caPool`: `/run/secrets/tunnel_origin_ca`;
- `noTLSVerify`: `false`;
- connect and TLS timeouts no longer than 10 seconds; and
- HTTP/1.1 origin transport so WebSocket upgrade remains explicit.

The one origin serves static web content, `/v1/` HTTP APIs, and `/v1/realtime` WebSocket upgrades. The final route must be the provider's explicit HTTP 404 catch-all; do not add a broad private-network or management route. Verify the dashboard route value before starting either connector because remotely managed ingress is provider state and is intentionally not stored in this repository.

The overlay removes the edge host port. PostgreSQL, Valkey, object storage, and the application server remain on the internal backend/frontend networks. Only `cloudflared-a`, `cloudflared-b`, and the edge join the dedicated `172.29.0.0/29` tunnel network. The edge trusts exactly connector addresses `.2` and `.3`, requires one syntactically bounded `CF-Connecting-IP`, overwrites `X-Forwarded-For`, and forwards one canonical client hop to the server. Requests from any other peer, including a peer forging Cloudflare headers, receive 403. The server continues to trust only the exact edge `/32`, so direct client headers cannot affect address rate limits.

Production uses the exact HTTPS public origin for `NEXA_PUBLIC_ORIGIN` and therefore for secure `__Host-` session cookies, CSRF checks, and WebSocket Origin validation. Changing DNS or the tunnel does not relax those checks.

## Optional Cloudflare Access

Cloudflare Access may protect the public hostname as an additional outer policy. Configure an application policy and validate Access assertions at Cloudflare. The origin passes Access headers without logging them, but NexaChat does not accept those headers as an application session or role. A valid Access identity must still authenticate to NexaChat; a forged or absent Access header must never bypass the application. Avoid service-token policies on interactive browser routes unless their credential lifecycle is separately reviewed.

## Multiple connectors and startup

`cloudflared-a` and `cloudflared-b` use the same tunnel token and establish independent connector connections. Two processes on one host protect against a process failure, not a host or network-location failure. For production availability, place replicas on at least two hosts or schedulers in the same tunnel, retain the same strict origin network controls, and avoid running more than one replica with the same container IP on a shared bridge.

Validate without printing resolved secrets:

```sh
docker compose -f compose.production.yml -f compose.cloudflare-tunnel.yml --profile cloudflare config --quiet
npm run verify:cloudflare-policy
npm run verify:cloudflare-tunnel
```

Start the hardened application first, confirm readiness from the connector network, then start the two connectors:

```sh
docker compose -f compose.production.yml -f compose.cloudflare-tunnel.yml --profile cloudflare up -d --wait
```

Do not use `docker compose config` without `--quiet` in tickets or shared logs: the model contains secret file paths and deployment topology. Neither connector publishes its metrics listener to the host. Collect metrics only through a host-local authenticated collector attached to the tunnel network.

## DNS, TLS, and firewall

Use the provider-created proxied CNAME for the public hostname and verify there is no A/AAAA record exposing the origin. Block all inbound Internet traffic to the host. The overlay publishes no origin port; also enforce that at the host/cloud firewall. Permit connector DNS and outbound TCP/UDP port `7844` to the official tunnel endpoints. If UDP is prohibited, select the provider-supported HTTP/2 transport deliberately and allow TCP 7844. Keep time synchronization and DNS resolution available. Review current official endpoint ranges before changing an egress allowlist.

TLS has two independently verified legs: browser-to-provider uses the provider edge certificate and connector-to-origin uses the private CA, exact `originServerName`, and TLS verification. Test expiration monitoring for both. Never reuse the tunnel token as a certificate secret.

## Smoke verification

The repository smoke script uses synthetic local secrets and connector-address probe containers; it never contacts or creates a real tunnel. It checks immutable image identity, non-root/read-only/no-capability connectors, secret mounts, zero host origin ports, network membership, forged-header rejection, web/API/WebSocket routing, secure cookies, trusted origin enforcement, Access non-bypass, health, and sensitive-log exclusion.

After an authorized real deployment, separately verify DNS, edge TLS, HSTS, registration/login, authenticated API requests, an authenticated WebSocket connection, client-address rate limits from two networks, both connector health states, and failover while stopping one connector. Record only status codes, bounded timings, image digest, revision, and redacted connector IDs.

## Rotate and revoke

Treat a copied token as a full tunnel credential. To rotate, create a replacement token in the dashboard, write it to a new root-owned file, start one connector with the replacement, verify healthy connections and application smoke tests, then roll the second connector. Revoke the old token only after no connector uses it. Confirm a container retaining the old file can no longer connect. Delete temporary files and rotate again if a token appears in a terminal transcript, environment, process list, log, backup, or ticket.

Emergency revocation order is: block the public route if safe, revoke/rotate the tunnel token, stop affected connectors, preserve bounded incident logs, inspect provider audit/connection events, rotate any origin or Access credentials that may also be exposed, then restore service with a new token after approval.

## Failure recovery

One unhealthy connector should drain while the other continues. Alert when healthy connector count is below two, both connectors restart repeatedly, the provider reports a degraded tunnel, or origin readiness fails. For a total outage, verify DNS/provider status, token validity, clock, DNS, outbound 7844, connector logs at `info` (never `debug` in production), edge certificate validity, CA path, and origin readiness in that order. Do not expose the edge host port as a workaround. Roll back to the previously verified image digest and repository revision if a connector upgrade caused the failure.

## Remove the tunnel

1. Announce the maintenance window and preserve required audit and availability evidence.
2. Remove or disable public-hostname and Access policies so new requests stop arriving.
3. Stop both connectors and verify the application edge still has no host-published port.
4. Revoke the tunnel token and confirm the provider reports zero connected replicas.
5. Delete the proxied DNS record, then delete the tunnel only after confirming no other route uses it.
6. Remove the token file and public CA copy from the host, rotate the origin certificate if it was tunnel-specific, and remove obsolete firewall egress rules.
7. Run external DNS/TLS probes to confirm the hostname and origin are no longer reachable. Retain only redacted evidence required by policy.
