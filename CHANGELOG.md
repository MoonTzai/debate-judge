# Changelog

## [Unreleased]

## [0.1.1] - 2026-09-07

- Reduced the repository to one canonical Skill source: `Skill-Judge.md`.
- Removed byte-identical repository mirrors and changed installation/build/test code so they are not recreated.
- Removed obsolete private baseline packaging from the public runtime closure.
- Removed one-off release/JOSS preparation status files from the product tree; durable information now lives in README, reproducibility, data/rights, Git history, releases, and the checksum manifest.
- Kept `web/judge.html` as the generated browser distribution while `web/src/` remains the maintainable source.

## [0.1.0] - 2026-09-07

- Published the first rights-cleared MIT Research Preview.
- Added the self-contained canonical Skill, modular Node/browser runtime, schemas, public deterministic tests, documentation, and generated browser artifact.
- Removed unresolved Sanctum artwork from the public runtime and replaced it with programmatic CSS.
- Fixed nested-repository boundary checks.
- Removed build-time timestamp injection so fresh-clone builds are byte-reproducible.
- Published GitHub Release `v0.1.0`.
