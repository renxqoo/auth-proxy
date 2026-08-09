# Contributing to auth-proxy

**English** · [中文](./CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing! This guide covers the dev setup, code style, and pull-request process. By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node 22+**
- **pnpm 11** (enable via corepack: `corepack enable`)
- **Postgres** + **Redis** (locally, or via `docker compose up -d postgres redis`)
- **Git**

## Dev Setup

```bash
git clone https://github.com/renxqoo/auth-proxy.git
cd auth-proxy
pnpm install

# start PG + Redis
docker compose up -d postgres redis

# create DB + migrate + seed
createdb auth-proxy
DATABASE_URL=postgres://localhost:5432/auth-proxy pnpm --filter @auth-proxy/db migrate
DATABASE_URL=postgres://localhost:5432/auth-proxy \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=devpassword123 \
  pnpm --filter @auth-proxy/db seed

# start mock + middle layer
DATABASE_URL=postgres://localhost:5432/auth-proxy \
REDIS_URL=redis://localhost:6379/2 \
COMPANY_API_BASE=http://localhost:4000 \
ADMIN_SESSION_SECRET=dev_secret_change_me_at_least_32_bytes_long \
  pnpm dev:all
```

## Project Layout

```
apps/
  server/         middle layer (Hono) — OAuth device flow, JWT, gateway, admin API
  admin-web/      admin console (Next.js)
  company-mock/   mock company app (dev only, never deployed)
packages/
  shared/         zod contracts + shared types
  db/             drizzle schema + migrations + seed
docs/             deployment & ops documentation
ops/              backup / restore / healthcheck scripts
```

## Common Commands

```bash
pnpm typecheck    # typecheck all packages (run before committing)
pnpm lint         # oxlint
pnpm build        # build all packages
pnpm --filter @auth-proxy/server test   # run the server test suite (Vitest)
```

## Code Style

- **Language:** TypeScript (strict mode, ESM). No `any` without justification.
- **Lint/Format:** we use [oxlint](https://oxc.rs) + [oxfmt]. Run `pnpm lint`. Don't introduce new lint warnings.
- **Commits:** use [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc. Keep the subject line under ~72 chars.
- **Comments:** match the surrounding density and tone. Comments explaining *why* (security tradeoffs, edge cases) are encouraged; comments restating *what* the code does are noise.

## Pull Request Process

1. **Open an issue first** for anything beyond a small fix or docs change — this avoids wasted work if the change doesn't fit the project direction.
2. **Branch from `main`** and name it descriptively, e.g. `fix/refresh-reuse-race` or `feat/add-jwks-cache`.
3. **Keep PRs focused** — one logical change per PR. Easier to review, easier to revert.
4. **Add or update tests** in `apps/server/test` for behavior changes. Security-relevant changes should include a regression test.
5. **Make sure CI is green** locally before pushing:
   ```bash
   pnpm typecheck && pnpm lint && pnpm --filter @auth-proxy/server test
   ```
6. **Fill in the PR template** (what / why / how tested).
7. **Be responsive** to review feedback.

## Security-Sensitive Changes

This is an auth project — security changes need extra care:

- If your change touches token handling, authentication, session management, or the gateway, **describe the threat model** in the PR.
- Never log secrets, tokens, or credentials.
- Prefer allowlists over denylists (see the gateway response-header passthrough as a model).
- If you're unsure whether something is a vulnerability, follow [SECURITY.md](./SECURITY.md) instead of a public PR.

## Reporting Issues

- **Bugs:** use the bug issue template — include reproduction steps, expected vs. actual behavior, and your environment (Node/pnpm/OS, server version).
- **Features:** use the feature template and explain the use case, not just the solution.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

Thanks for making auth-proxy better! 🚀
