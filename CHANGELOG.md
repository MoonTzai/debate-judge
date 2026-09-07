# Changelog

All notable public-release changes will be recorded here once the repository is actually published. Dates below describe the local candidate only and are not public-history claims.

## [Unreleased]

### 2026-09-07 local v0.1.0 research-preview candidate

- Regenerated candidate browser artifact from the hardened public source: `web/judge.html` SHA-256 `d4f1931afab72863f791812150f1d852c80fcfaa0bbb929f7a980d78d8d54925`.
- Current canonical Markdown mirror set: SHA-256 `e814e71073bd097669933a8de3742b05882f5e602f9ee7ab4d210a49dc17fd4b`.
- Added modular runtime/Web source closure to a whitelist-only staging area.
- Added public-facing installation, usage, architecture, reproducibility, rights, governance, AI-use, JOSS-readiness, contribution, test-status, and release-blocker documentation.
- Hardened the public-candidate source by removing fixed local development paths/private design-path references, synchronizing the R6a-3 CSS template to the production stylesheet, and restoring the lightweight-shell independent-context contract.
- Executed `tests/run-public.js` on Node v24.16.0 / Windows x64; final result `PUBLIC TEST SUITE PASS`.
- Fixed the nested-repository self-check boundary so repo-root checks cannot escape to a private parent workspace; regenerated the embedded closure and mirrors through the normal sync chain.
- Executable secret scan passed after rebuild; post-build manifest includes the generated `web/dist` closure.
- No public repository, release, DOI, benchmark result, or JOSS submission is claimed.
