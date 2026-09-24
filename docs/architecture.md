# Semantic Edition architecture

The canonical rule source is `Skill-Judge.md`. `install-skill.js::BLOCKS` declares its 35 extractable runtime blocks. Two complete compatibility mirrors, `Debate-Judge.md` and `.claude/skills/debate-judge/SKILL.md`, are retained. They are not independently authored policies. The obsolete nested Claude controller is excluded; use the root controller.

## Execution and source authority

`executor/core.js::ROUNDS` declares R1, R2, R2.5, R3, R4, R4.5, R5A, R5B, R6a, R6b. `executor/host-node.js` supplies orchestration, dependency checks, prompt assembly, rendering, and recovery. R7 plain-language rewriting and R8 reader guidance are post-processing, not a replacement for adjudication.

`executor/sc-source-roster.js` handles source identity extraction. `executor/sc-original-integration.js` applies source-grounded SC policy and bounded review/reopening instructions to the established rounds. Original transcript content remains the evidence base; pipeline artifacts represent interpretations and authority; HTML presents those interpretations. Later explanation must not silently change earlier judgment.

The SC policy separates occurrence, completion, scope, survival, and adjudicative importance. A completed local SC does not automatically decide the winner. This branch distinguishes marginal local completion from completion affecting the main dispute; that choice can produce a different mainline type from Deliberative/V10.

## Post-processing

R7 uses paragraph/inline/table reading context, coherent rewriting, independent model review, and bounded repair. Slots transport rewritten text into the original DOM; they do not mechanically define semantic correctness. R8 uses source-backed guide cards and review. Material upstream objections request review at the relevant earlier stage; post-processing does not rewrite the verdict.

## Browser and compatibility

`web/build-judge-web.js` derives browser modules from the installer closure, applies existing r6 browser adapters, and includes source seeds in a virtual filesystem. `web/src/` contains the UI, flight/history interfaces, report host, and engine. Public packaging preserves r6 adapters and storage identities. Packaging tests compare generated Node/Web prompts and SC policy.

Historical cutover/router/pilot modules remain because the builder imports them. Their private state, evaluation corpora and receipts are excluded. The distributed production attestation is `mode: off`; private cutover/pilot workflows are not public reproduction entry points. Compatibility declarations do not authorize activating another branch.

## Integrity boundary

The 35-block installer verifier and browser build are current source-closure checks. The inherited legacy self-check has known assumptions about old embedded-block placement, SC terminology and inline CSS. It remains available and reports failures; see [snapshot notes](semantic-edition.md). Do not rewrite frozen rules or run the old embed/sync chain merely to turn legacy checks green. Develop such corrections as a separately reviewed revision.
