<!--
Thanks for the PR! Read CONTRIBUTING.md first.
If this fixes an issue, add "Closes #123" on its own line below.
Security-sensitive change? Describe the threat model in "Why".
-->

## What

<!-- One or two sentences: what does this PR change? -->

## Why

<!-- The motivation / problem. If security-relevant, describe the threat model. -->

## How

<!-- Brief walkthrough of the approach. Call out anything tricky. -->

## Testing

<!-- How did you verify this? e.g. unit tests, manual repro steps, typecheck/lint. -->
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes (no new warnings)
- [ ] `pnpm --filter @auth-proxy/server test` passes
- [ ] Added/updated tests for behavior changes
- [ ] No secrets / tokens / credentials logged or committed

## Checklist

- [ ] PR targets `main` and is focused on one logical change
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:` …)
- [ ] Updated documentation (README / docs/) where relevant
