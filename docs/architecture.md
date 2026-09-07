# Architecture

## Source of truth

Debate-Judge uses a single-source layout:

1. `Skill-Judge.md` is the only canonical rule/runtime Skill source.
2. `install-skill.js::BLOCKS` declares the extractable self-contained runtime closure embedded in that Skill.
3. Root execution code, `executor/`, `schemas/`, `assets/`, and selected `scripts/` are the maintainable file-level implementation.
4. `web/src/` plus `web/build-judge-web.js` are the browser source layer.
5. `web/judge.html` is a generated distribution artifact.

Repository-local copies of the Skill are intentionally not maintained. Agent-specific install targets are generated when needed.

## Execution model

The current core declares ten execution units in `executor/core.js::ROUNDS`: R1, R2, R2.5, R3, R4, R4.5, R5A, R5B, R6a, and R6b. R7 plain-language output and R8 reader guide are optional post-processing layers.

## Single-file closure

`scripts/embed-assets.js` rebuilds the embedded asset blocks in `Skill-Judge.md` from `install-skill.js::BLOCKS`. `pipeline-controller.js sync-embed` then refreshes the embedded pipeline controller in the same canonical file.

The browser builder uses the same runtime closure and embeds only `Skill-Judge.md` as the rule seed. It does not carry a second Markdown mirror.

## Private/public boundary

The public source must not depend on private `Upload/`, real `Output/` records, credentials, local absolute paths, or private audit artifacts. Public tests are intentionally limited to rights/privacy-cleared deterministic checks.

## Semantic authority

Mechanical validation protects software integrity and artifact contracts. It does not override semantic adjudication or prove substantive correctness. Scientific validity requires separate empirical evaluation.
