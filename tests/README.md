# Public Tests

This directory is the **public release test subset** for Debate-Judge. It is intentionally smaller than the private development/audit suite because some private tests depend on real debate outputs, transcript-derived fixtures, or historical Wayfinder evidence that has not been cleared for redistribution.

## Run

```sh
node tests/run-public.js
```

The public runner performs, in order:

1. embedded-closure verification through `install-skill.js --verify-only`;
2. the formal project `pipeline-controller.js self-check`;
3. syntax checks for the Web builder and modular Web sources;
4. selected source-integrity and pure-runtime tests.

Current selected tests are:

- `self-check.test.js`
- `single-file-parity.test.js`
- `wayfinder-runtime.test.js`
- `slicing-contract.test.js`
- `rounds-source.test.js`
- `dictionary-consistency.test.js`
- `key-engine.test.js`
- `dead-assets.test.js`

## What this suite proves

A PASS supports claims about source closure, syntax, mirror consistency, runtime contracts, selected deterministic ABI behavior, and release-source hygiene.

A PASS does **not** establish adjudication accuracy, human agreement, benchmark superiority, research impact, or independent scientific reproduction.

## Why some private tests are excluded

The private project contains broader tests that may inspect historical `Output/` artifacts, transcript-derived HTML/JSON fixtures, or private design/audit evidence. Those tests are not copied merely to increase the public suite count. See `../PUBLIC-TEST-STATUS.md` for the current exclusion policy and categories.

Any future fixture added here must be provenance-checked for copyright, privacy, personal data, and hidden local paths before inclusion.
