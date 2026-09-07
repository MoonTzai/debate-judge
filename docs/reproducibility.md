# Reproducibility

Status: local nested-repository acceptance completed; fresh external-clone reproduction remains a pre-publication check.

## Baseline commands

The inspected source exposes these software checks:

```sh
node install-skill.js --verify-only
node pipeline-controller.js self-check
node tests/run-public.js
node web/build-judge-web.js
```

Do not treat those commands as scientific evaluation. Real adjudication uses an external model service and may send transcript content outside the local machine.

## Current 2026-09-07 evidence

- Runtime used for the local public acceptance: Node v24.16.0, Windows x64 (`win32`, OS release `10.0.26200`).
- `install-skill.js --verify-only`: PASS, 31 embedded blocks.
- `web/build-judge-web.js`: PASS after MIT/CSS hardening; current `web/judge.html` SHA-256 `7753c917b0b9097f53cbeec894b48734a4ddf86b9f91cccd7523c65860688710`.
- `scripts/secret-scan.js .`: PASS, no key risk detected across 84 scanned files.
- `tests/run-public.js`: PASS, including formal project self-check and the declared public deterministic suites.
- The three Markdown distribution mirrors are byte-identical at SHA-256 `81863147ed0a9833e1380e92e631022b5b5c63157822c874f981c5d30413ba09` and declare MIT.
- Final publishable-tree manifest covers 83 non-manifest entries. `web/dist/.inputs.json` and `web/dist/judge-bundle.js` are intentionally Git-ignored reproducible intermediates; `web/judge.html` is the tracked generated deliverable.
- A nested-repository path bug in the project self-check was found on first execution and fixed: project-root checks now remain inside the current repository rather than inspecting `__dirname/..`.

## Release acceptance still required

Local post-hardening acceptance is GREEN. After the first public push, repeat the same build/test/scan chain from a fresh clone and compare the regenerated publishable manifest. The current nested candidate is whitelist-only and its runtime/tests are repo-relative, but until push it still physically resides inside the private project workspace.

## Scientific reproduction

A software smoke test is not a result-reproduction study. Any claim about adjudication quality requires a frozen software version, authorized data, human/reference protocol, baselines, model/configuration records, uncertainty/error analysis, and reproducible result artifacts.
