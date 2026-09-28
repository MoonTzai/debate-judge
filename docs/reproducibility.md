# Reproducibility

Check out tag `semantic-2026.09.28-r8-debug` for this snapshot. Complete sources, compatibility mirrors, project-generated background images and generated HTML are versioned. The earlier `semantic-2026.09.24-r6` tag is retained unchanged; the intervening 2026-09-25 candidate was not separately published. The checksum manifest is supplementary transport integrity, not a substitute for files or a semantic authority.

## Offline software verification

Validated environment: Node.js 24.16.0, Windows x64. No npm package installation or external API credential is needed:

```sh
node install-skill.js --verify-only
node web/build-judge-web.js
node tests/run-public.js --current
node scripts/secret-scan.js .
```

`tests/semantic-edition.test.js` compares a rebuild with the distributed HTML, checks mirrors, unique embedded assets, idempotent asset regeneration and module loading, and compares Node/Web prompts and SC policy. Sources use LF line endings; the distributed build contains no current-time stamp. `web/dist/` is an ignored build intermediate.

Run `node tests/run-public.js` to inspect all inherited public checks. It currently exits nonzero: the old self-check and key-engine suites fail, as does `pipeline-controller.js self-check`. These failures also occur in unmodified r6. They are not suppressed or converted into passing results. See [limitations](semantic-edition.md).

`node scripts/accept-release.js --build` verifies the closure and builds without rewriting the frozen Skill. `--test-current` runs the documented subset; `--test` runs all public checks and currently reports known failures.

## Scientific reproduction

Private transcripts, actual model responses, reports and run logs are excluded. Synthetic tests verify transport, review behavior, contracts and source propagation. They do not reproduce human agreement, SC recall/precision, or novice comprehension quality.

Empirical work must record the exact tag/commit, provider/model version, sampling parameters, judge settings, authorized corpus, annotation protocol, repeated-run variation, cost/latency, and failures. Evaluate discovery, classification, outcome impact and report fidelity separately. Include difficult/failed runs.

Publication packaging does not establish journal readiness. Public history, maintenance, research use and external evaluation must come from actual evidence, not backdated or manufactured records.
