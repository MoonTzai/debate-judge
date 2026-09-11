# Changelog

## [Unreleased]

## [0.1.2] - 2026-09-11

- Fixed substantive S8 P1/P2/P3 and S8 completion-consistency validation so it no longer depends on the historical compatibility marker `S8.COMPLETE`.
- Unified dictionary-side literal extraction across approved `data` / `allData` aliases and added public regression coverage for the no-bypass authority contract.
- Aligned the canonical Skill rule table with current runtime authority and rebuilt the single-file browser distribution from the synchronized source.
- Hardened public release acceptance and ignore rules against accidental inclusion of local evaluation datasets and corpus files.

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
