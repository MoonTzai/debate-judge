# Public Test Status

Status: **public source-integrity subset executed successfully in the nested local public repository**.

The private upstream `tests/run-all.js` currently enumerates more than sixty suites. It includes tests that depend on private historical evidence, real `Output/` runs, fixed local paths, or transcript-derived fixtures. Those dependencies are deliberately not copied into this candidate merely to maximize a suite count.

## Public runner assembled

The candidate now contains `tests/run-public.js`. It is intentionally named and documented as a **public subset**, not “all upstream tests”.

Current public runner coverage:

- `install-skill.js --verify-only` closure verification;
- formal `pipeline-controller.js self-check`, including the public-safe `tests/self-check.test.js` and Ω1 source/asset parity checks;
- Node syntax checks for the Web builder and modular Web sources;
- `single-file-parity.test.js`;
- `wayfinder-runtime.test.js` — pure in-memory ABI fixtures, no private Wayfinder documents;
- `slicing-contract.test.js` — portable OS temp-directory injection;
- `rounds-source.test.js`;
- `dictionary-consistency.test.js`;
- `key-engine.test.js`;
- `dead-assets.test.js`.

Supporting public maintenance scripts included for those tests are `scripts/generate-input-contract.js`, `scripts/key-checker.js`, and `scripts/embed-assets.js`.

On 7 September 2026, the runner was executed from `Debate-Judge-Public/` under FolderBridge 0.8.27 using Node v24.16.0 on Windows x64. The initial nested-repository acceptance exposed and fixed a repository-boundary bug in `pipeline-controller.js self-check`. After the later MIT/rights hardening (Skill license update, removal of the two Sanctum WebPs, CSS-only background, builder closure update), the full synchronization/build/public-test/secret-scan chain was run again from the current source. Final result remains: `=== PUBLIC TEST SUITE PASS ===`. The executable secret scan passed across 84 scanned files. Release postconditions also passed for mirror equality, MIT propagation into canonical/generated content, artwork absence, private-root path absence, and no API-config instance. No external model/API adjudication call is part of this suite.

## Deliberately excluded from the first public subset

Examples of currently private/not-yet-cleared tests include:

- Wayfinder freeze-break / activation-eligibility tests that reference private `Upload/Wayfinder-...` evidence;
- `executor-core.test.js`, because its tail imports those private Wayfinder suites;
- `contract-module.test.js`, `a7-features.test.js`, `omega1-mechanical-smoke.js`, `adjudication-e2e.test.js`, and related tests that inspect real `Output/` runs or fixed local paths;
- tests using `tests/fixtures/report-035350*.html`, `report-051013.html`, or `real-r*-*` transcript-derived fixtures until redistribution/privacy rights are separately cleared;
- `web-contract.test.js` until its `web/tests/wt1-*.html` fixtures are separately audited;
- `asset-sources.test.js` until its active mutation behavior and stale hard-coded BLOCK count are release-hardened.

The nine chart SVG goldens may be suitable later, but they remain provenance/rights-review items rather than automatically public assets.

## Policy

No reduced runner may be labeled “all upstream tests” unless it actually covers that set. Private provenance/audit tests may remain private when their evidence cannot be released, provided the public documentation says so and no scientific/release claim silently relies on them.
