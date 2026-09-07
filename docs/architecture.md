# Architecture

Status: local public-candidate documentation, 2026-09-07. It describes the inspected implementation; it is not a claim of empirical validity.

## Source-of-truth layers

1. `Skill-Judge.md` is the canonical single-file rule/runtime distribution source.
2. `Debate-Judge.md` and `.claude/skills/debate-judge/SKILL.md` are distribution mirrors and must remain byte-identical to the canonical Skill.
3. `install-skill.js::BLOCKS` enumerates the extractable Node/runtime closure.
4. Root execution code, `executor/`, `schemas/`, `assets/`, and selected `scripts/` are the file-level implementation.
5. `web/src/` plus `web/build-judge-web.js` form the browser source layer.
6. `web/judge.html` is a generated single-file distributable, not the sole canonical source.

## Execution model

The current core declares ten execution units in `executor/core.js::ROUNDS`: R1, R2, R2.5, R3, R4, R4.5, R5A, R5B, R6a, and R6b. R7 plain-language output and R8 reader guide are optional post-processing layers. The source contains compatibility and recovery mechanisms that should not be interpreted as scientific evidence.

## Web modularity

The browser build derives runtime modules from `install-skill.js::BLOCKS` and adds explicit Web modules from `web/src/`. It embeds the two Markdown seeds and non-JavaScript runtime assets into a virtual file system. This modular source layer is the intended testing and maintenance surface; the generated HTML is a convenience artifact.

## Private/public boundary

The public source closure must not depend on the private evidence workspace, `Upload/`, `Source/`, real `Output/` records, historical audit packages, credentials, or local absolute paths. Historical comments or provenance references that mention such paths are release-hygiene items and do not authorize copying the referenced private files.

## Semantic authority

Mechanical validation, schema checks, and runtime gates protect software integrity. They do not override the project's semantic-first adjudication principle or establish that a debate judgment is substantively correct. Scientific validity requires separate empirical evaluation.
