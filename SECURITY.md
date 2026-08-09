# Security Policy

**English** · [中文](./SECURITY.zh-CN.md)

auth-proxy is an authentication/authorization middle layer — security is a core feature, not an add-on. We take vulnerabilities seriously and appreciate responsible disclosure.

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities privately using **one** of these channels:

1. **GitHub Security Advisories (preferred):** use the
   ["Report a vulnerability"](https://github.com/renxqoo/auth-proxy/security/advisories/new)
   feature on the repository. This lets us discuss and patch the issue privately before public disclosure.
2. **Email:** send the details to the maintainer at the address listed on the GitHub profile, with the subject line starting with `[SECURITY] auth-proxy`.

Please include:

- A description of the issue and its potential impact.
- The exact version / commit you tested against.
- Steps to reproduce (proof-of-concept, logs, or a minimal test case).
- Any suggested mitigation, if you have one.

## Response Timeline

| Step | Target |
|------|--------|
| Acknowledge receipt of your report | within **48 hours** |
| Initial assessment + severity rating | within **5 business days** |
| Fix or mitigation for high-severity issues | within **30 days** of confirmation |
| Coordinated public disclosure | after a fix is released (credit given unless you prefer to remain anonymous) |

We will keep you informed throughout the process. If you have not heard back within the timelines above, please follow up.

## Scope

In scope:

- The middle layer (`apps/server`) and admin console (`apps/admin-web`) runtime behavior.
- Authentication flows (device flow, token issuance, refresh rotation, reuse detection).
- Token handling (JWT signing/verification, company-token proxying).
- Rate limiting, CSRF, session management, admin authentication.

Out of scope:

- Vulnerabilities in dependencies — report those upstream (we rely on Dependabot + regular updates here).
- Issues in the `company-mock` app — it is a **mock** for local development only, never deployed to production.
- Self-inflicted misconfiguration (e.g. committing a real `.env`, exposing ports manually).

## Supported Versions

Only the latest release line (`main`) receives security updates. There is no LTS branching at this time.

| Version | Supported |
|---------|-----------|
| latest (`main`) | ✅ |
| older releases | ❌ |

## Disclosure Policy

- We follow **coordinated disclosure**: details are published after a fix is available.
- We will credit reporters by name unless you request anonymity.
- We kindly ask that you do not publicly disclose the vulnerability before a fix is released.

## Hardening Notes

Production hardening details — enforced secret lengths, `assertProductionConfig()`, host-header-injection guards, refresh-reuse detection — are documented in [docs/docker/04-config-secrets.md](./docs/docker/04-config-secrets.md). Please review it before deploying.

Thank you for helping keep auth-proxy and its users safe.
