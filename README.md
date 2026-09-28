# Debate-Judge Semantic Edition

[中文](README.zh-CN.md) · Branch: `semantic-edition` · Snapshot: `semantic-2026.09.28-r8-debug`

Structure-aware analysis and adjudication for competitive Chinese debate. Semantic Edition preserves the GPT6 r6 branch's staged pipeline, source-grounded structural clash (SC) analysis, judge settings, report layout, recovery, plain-language explanation, and reader guide. The branch name describes its development emphasis; the inference provider/model is configurable.

This snapshot includes Chinese/English interface switching, the project's ComfyUI-generated dark/light backgrounds, the scrolling-layout repair, and R8 metadata/draft recovery. It also aligns final clash assessments with report summaries, routes substantive R8 objections back to the responsible analysis stage, and adds one-click Debug export beside the run log. New-run and resume messages now reflect the actual entry point. The UI language setting does not translate transcripts, reports, or raw logs and does not change judging prompts.

**Status: a frozen research-software preview, not a validated judging benchmark or an all-tests-green release.** The current deterministic subset and packaging checks pass. Two inherited legacy suites and the old project self-check still fail; the full public runner exposes those failures. See [snapshot notes](docs/semantic-edition.md).

## Use the browser application

Open [web/judge.html](web/judge.html) locally in a modern browser. The single HTML contains the application; real adjudication still requires an external model service and may incur cost. Configure your own endpoint and credentials locally. Do not commit transcripts, API configuration, sessions, or reports.

## Build and verify

Validated with Node.js 24.16.0 on Windows x64. No npm installation is required.

```sh
git clone --branch semantic-edition https://github.com/MoonTzai/debate-judge.git
cd debate-judge
node install-skill.js --verify-only
node web/build-judge-web.js
node tests/run-public.js --current
```

`--current` explicitly excludes the disclosed legacy failures. To reproduce the complete public test status, including those failures, run `node tests/run-public.js`.

The packaging test rebuilds the complete HTML, compares the artifact, loads its runtime, and compares Node/Web round prompts and SC policy. It does not call a model or establish semantic accuracy.

## Source layout

- `Skill-Judge.md`: canonical rules and the complete 35-block embedded runtime.
- `Debate-Judge.md` and `.claude/skills/debate-judge/SKILL.md`: identical compatibility mirrors retained by this frozen branch, not independently authored policies.
- `pipeline-controller.js`, `executor/`, `scripts/`, `schemas/`, `assets/`: execution, contracts, prompts, post-processing, and rendering.
- `web/src/`, `web/assets/`, `web/build-judge-web.js`: maintainable browser source, project-generated backgrounds, and deterministic builder.
- `web/judge.html`: generated single-file distribution.
- `tests/`: public deterministic tests with synthetic or source-integrity inputs.
- `docs/`: architecture, usage, provenance, validation limits, and research guidance.

Ten core execution units: R1, R2, R2.5, R3, R4, R4.5, R5A, R5B, R6a, R6b. R7 plain-language output and R8 reader guide are separate post-processing stages. This branch does not enable private S4B production cutover or import the V10/Deliberative authority architecture.

## Research and citation

Use the exact snapshot tag or commit for experiments; a branch can advance. [CITATION.cff](CITATION.cff) identifies the software, not a published paper. No DOI, benchmark superiority, human-equivalence, or independent judging validation is claimed. Future empirical work must disclose authorized data, model/settings, costs, failures, human reference procedures, and uncertainty.

## Documentation

- [Snapshot and known limitations](docs/semantic-edition.md)
- [Installation](docs/installation.md), [usage](docs/usage.md), [architecture](docs/architecture.md)
- [Reproducibility](docs/reproducibility.md), [public tests](tests/README.md)
- [Data and rights](docs/data-and-rights.md), [AI assistance](docs/ai-usage.md)
- [Contributing](CONTRIBUTING.md), [support](docs/support-and-governance.md)

## License

The maintainer authorized this distribution, including the project backgrounds generated locally with ComfyUI, under the [MIT License](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.md) record the corrected artwork provenance and other attribution boundaries. Real competition corpora, private run evidence, and credentials are not distributed.
