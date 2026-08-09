# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
