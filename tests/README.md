# Public deterministic tests

Build first with `node web/build-judge-web.js`.

- `node tests/run-public.js --current`: installer closure plus 15 current deterministic suites. Exclusions are explicit, not counted as passing.
- `node tests/run-public.js`: all 17 test files, installer verifier and legacy project self-check. Currently exits nonzero because two legacy suites and the project self-check fail.

Coverage includes source/round propagation, semantic boundary contracts, judge settings, plain-language paragraph context and review/repair, reader-guide upstream-review behavior, browser module/prompt parity, complete Skill mirrors, and reproducible packaging. Inputs are synthetic/source-integrity fixtures; there are no paid model calls.

Inherited failures remain in `self-check.test.js` and `key-engine.test.js`, described in [snapshot notes](../docs/semantic-edition.md). The runner executes them by default. There is no catch-all expected-failure conversion.

Private tests requiring competition transcripts, historical runs or external audit directories are omitted for rights and independent reproducibility, not counted as passing. Public semantic benchmarks require a separately documented data and annotation protocol.
