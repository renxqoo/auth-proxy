# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — OAuth 2.1 core: authorization_code + PKCE + RFC 7591 (TDD)
- **RFC 7591 dynamic client registration (breaking):** `/register` now accepts `client_metadata` (client_name, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method) and returns snake_case response with `client_id`, `client_secret`, `client_id_issued_at`, `client_secret_expires_at=0` + echoed metadata. Errors use `invalid_client_metadata`. Migration `0008` adds `redirect_uris`, `grant_types`, `token_endpoint_auth_method` columns to apps.
- **authorization_code flow (RFC 6749 §4.1 + PKCE RFC 7636):** new `/authorize` endpoint validates response_type, client_id, redirect_uri (against registered URIs), scope (three-tier), and PKCE (S256 mandatory). Creates auth code in Redis (120s TTL), 302 redirects with code+state.
- **PKCE S256 enforcement (OAuth 2.1):** `code_challenge_method` must be S256 (plain forbidden). Token exchange verifies `code_verifier` via timing-safe SHA256 comparison.
- **authorization_code token grant:** `POST /token grant_type=authorization_code` with code + code_verifier → validates code status, redirect_uri match, PKCE → issues tokens. Public clients (no secret) authenticated via code record's clientId.
- New config: `AUTH_CODE_TTL` (default 120s). New error codes: `unsupported_response_type`, `unauthorized_client`.
- Tests: `register.rfc7591.test.ts` (6), `authorize.pkce.test.ts` (8), `token.authcode.test.ts` (8).

### Added — RFC 8414 metadata, client_id claim, WWW-Authenticate (TDD)
- **New `route_policies` table:** maps path patterns to required scopes (e.g. `/api/orders*` → `orders:read`). Managed via admin console.
- **Gateway now enforces scope before forwarding:** a token must carry the scope the path demands, else `403 insufficient_scope`. Previously the gateway only verified the JWT signature — scope was not checked at the proxy layer.
- **Default-deny:** paths without a configured policy are blocked (403), forcing explicit configuration. This is the enterprise API-gateway standard (Kong / AWS API Gateway pattern).
- Wildcard path matching: `/api/orders*` matches `/api/orders` and `/api/orders/123`.
- Null-scope policies: `scope=null` means "valid token only" (for self-info endpoints like `/me`, `/api/profile`).
- Method-scoped policies: `method` can be `GET`/`POST`/null (null = all methods).
- Admin console: new "路径策略" (Route Policies) management page.
- New endpoints: `GET/POST/DELETE /admin/web/route-policies`.
- Migration `0007_rich_inhumans.sql`. Seed inserts 6 default policies (company-mock endpoints).
- Tests: `gateway.scope-policy.test.ts` (8 tests covering allow/deny/default-deny/wildcard/method).
- This closes the gap where the gateway was a transparent pipe for scope — now it's a real authorization boundary independent of the resource server.

### Added — three-tier dynamic scope management (OAuth 2.1)
- **New `scopes` table (Tier 1):** global scope definitions stored in the DB, manageable via admin console (`GET/POST/DELETE /scopes`). Seed inserts 7 defaults (`orders:read`, `admin`, system scopes, etc.). Replaces the static env-var whitelist as the source of truth (env `ALLOWED_SCOPES` retained as fallback when table is empty).
- **Client-level scope binding (Tier 3):** `apps.allowed_scopes` column lets admins restrict each client to a scope subset (empty = all, default). Enforced at `/device_authorization`. Closes the gap where any client could request any whitelisted scope (e.g. `admin`).
- **System-scope flag:** `scopes.is_system` marks `offline_access` / `company.api` as middle-layer scopes, exempt from Tier 2 (user narrowing) and Tier 3 (client binding).
- Admin console: new "Scope" management page + "edit scope" dialog on the clients page.
- New endpoints: `GET/POST/DELETE /admin/web/scopes`, `POST /admin/web/apps/:id/scopes`.
- Migration `0006_condemned_pyro.sql` (CREATE TABLE scopes + ALTER apps).
- Tests: `scope.client-binding.test.ts` (Tier 3 enforcement); updated `device-auth.scope.test.ts` + `security.*` mocks.

### Changed — OAuth 2.1 compliance fixes
- **Access tokens now carry an `aud` (audience) claim** (RFC 9068 §3). Verification rejects tokens whose `aud` doesn't match `JWT_AUDIENCE`, preventing token confusion. New env: `JWT_AUDIENCE`.
- **Refresh-token rotation now returns a new `refresh_token`** in the response body (OAuth 2.1 mandates rotation). Previously the response omitted the rotated token.
- **Refresh scope is inherited from the session** instead of the hardcoded `"company.api offline_access"`, so granted scopes no longer drift after refresh.

### Added — OAuth 2.1 compliance
- **Scope validation at `/device_authorization`**: requested scopes are checked against an `ALLOWED_SCOPES` allowlist; out-of-set requests now return `invalid_scope` (previously dead code). New env: `ALLOWED_SCOPES`.
- **Scope narrowing at token issuance**: requested scopes are intersected with the user's actual permissions (`user.scopes`); requesting a scope the user doesn't hold returns `invalid_scope`.
- Tests: `jwt.aud.test.ts`, `token.refresh-rotation.test.ts`, `device-auth.scope.test.ts`.

### Added
- Bilingual documentation (English default + Chinese): `README.zh-CN.md`, `SECURITY.zh-CN.md`, `CONTRIBUTING.zh-CN.md`.
- Open-source governance files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this `CHANGELOG.md`.
- GitHub issue templates (bug report, feature request) and a pull-request template.
- Dependabot configuration for dependency updates.
- README badges (CI, license, Node, pnpm), a Features section, a tech-stack table, a full API-endpoint reference, and an end-to-end device-flow walkthrough.

## [0.1.0] - 2026-08-06

### Added
- OAuth 2.0 device authorization flow (RFC 8628): `/device_authorization`, `/token`, `/verify`, `/register`.
- RS256 JWT issuance with rotatable signing keys; public key exposed at `/.well-known/jwks.json`.
- Refresh-token rotation with reuse detection (`REFRESH_REUSE_GRACE_SEC`); replay past the grace window auto-revokes the session and logs a `[REUSE]` audit event.
- API gateway at `/proxy/*` that forwards requests to the company app using the stored company token (`ct_*`); company credentials never leave the proxy.
- Redis-backed rate limiting (login by IP, `/token` by client, `/proxy` by session).
- CSRF protection via double-submit cookie on `/verify/login`; `client_secret` stored scrypt-hashed.
- Production config validation (`assertProductionConfig()`) rejecting weak `ADMIN_SESSION_SECRET`.
- Admin console (Next.js) at `/admin`: registration tokens, client management, audit log (login + API), admin management.
- Monorepo with pnpm workspaces + Turborepo: `packages/shared` (zod contracts), `packages/db` (drizzle schema + migrations + seed), `apps/server`, `apps/admin-web`, `apps/company-mock`.
- Mock company app (`company-mock`) with test users alice/bob for local development.
- Docker deployment: `docker-compose.yml`, per-app `Dockerfile`s + prebuilt variants, `nginx.conf` as the sole public entry point.
- Emergency deploy script (`deploy.sh`) with local pre-build to avoid OOM on low-spec servers.
- GitHub Actions CI/CD: `build.yml` (build + push images to GHCR), `deploy.yml` (manual deploy).
- Ops tooling: `ops/backup.sh`, `ops/restore.sh`, `ops/healthcheck.sh`; auto-installed cron for daily Postgres backups and 5-min health checks.

[Unreleased]: https://github.com/renxqoo/auth-proxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/renxqoo/auth-proxy/releases/tag/v0.1.0
