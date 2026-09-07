# Release Blockers — local v0.1.0 candidate

Snapshot date: 2026-09-07. These are blockers to a public/OSI release, not a statement that the research prototype is unusable.

## B1 — Rights/license closure — RESOLVED FOR CURRENT PUBLIC SOURCE

On 7 September 2026 the project right holder explicitly authorized MIT relicensing for Debate-Judge content they have authority to license. The three canonical/distribution Skill mirrors and the install-shell template now declare MIT, and a top-level MIT `LICENSE` plus `THIRD_PARTY_NOTICES.md` are present. A targeted scan found no bundled long-form third-party publication/competition-handbook/course excerpt. Scholarly theory names remain attribution references rather than vendored works.

## B2 — Local nested-repository release acceptance — RESOLVED

On 7 September 2026 the public candidate was executed from `Debate-Judge-Public/` using Node v24.16.0 on Windows x64. Final `tests/run-public.js` result: **PUBLIC TEST SUITE PASS**. Closure verification, formal project self-check, Web-source syntax checks, single-file parity, Wayfinder runtime ABI fixtures, slicing contract, rounds-source, dictionary consistency, key-engine, and dead-assets all passed.

The first public run exposed and then fixed one non-semantic repository-boundary bug: `pipeline-controller.js self-check` used `__dirname/..` and accidentally inspected private-parent mirrors when the public repository was nested. The corrected check remains inside the current repository root, and the embedded closure/mirrors were regenerated through the project's normal synchronization chain.

## B3 — Generated HTML rebuild — RESOLVED AFTER RIGHTS HARDENING

`web/judge.html` was regenerated from the current MIT/CSS source; hand-patching was not used. Current accepted SHA-256: `7753c917b0b9097f53cbeec894b48734a4ddf86b9f91cccd7523c65860688710`. The generated `web/dist` closure was rebuilt in the same run.

## B4 — Public test subset execution — RESOLVED AFTER RIGHTS HARDENING

The declared rights/privacy-bounded public subset was rerun on the current source and ended with `=== PUBLIC TEST SUITE PASS ===`. The executable secret scan also passed across 84 scanned files, and release postconditions confirmed MIT propagation, mirror equality, artwork exclusion, private-path exclusion, and no API-config instance.

## B5 — Private provenance tests are not part of the public distribution

The private runner contains more than sixty suites, including Wayfinder provenance/freeze-break tests backed by private `Upload/` evidence and tests using real historical `Output/` runs. They are not silently copied or relabeled as public. Any future public equivalents require minimal rights-cleared fixtures or an explicit disclosure that the audit remains private.

## B6 — Asset rights — RESOLVED BY EXCLUSION

The two Sanctum WebP derivatives were moved out of the public candidate into private rights quarantine. `web/src/app.css` now uses programmatic gradients and `web/build-judge-web.js` no longer reads those image files. Their ownership no longer blocks the first public release.

## B7 — Local clean build/reproduction — RESOLVED AFTER RIGHTS HARDENING

The current nested candidate completed source synchronization, browser rebuild, public tests, executable secret scan, path/privacy postconditions, and manifest regeneration under Node v24.16.0 / Windows x64. A fresh external clone remains required after the first Git commit/push.

## B8 — Git/publication bootstrap — PARTIALLY RESOLVED

FolderBridge 0.8.27 / Git Publisher 1.5.0 now supports a workspace-relative nested `repo_path`, so `Debate-Judge-Public/` can be a dedicated Git repository while remaining inside the single `Debate-Judge` FolderBridge workspace. The private parent root is not a Git repository and has not been initialized.

Post-hardening engineering re-acceptance has closed B3/B4/B7. The remaining release action is now Git bootstrap/publication: initialize `Debate-Judge-Public/` as `main`, create the first honest commit, create the public GitHub repository, push, then fresh-clone and rerun acceptance. The authenticated GitHub identity is `MoonTzai`; intended remote: `MoonTzai/debate-judge`.

## B9 — JOSS temporal/impact requirements not yet mature

The JOSS six-month public-development clock has not started because no public repository exists yet. Research-use/impact evidence must also be accumulated and documented before submission.
