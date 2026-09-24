> **Branch: Debate-Judge · Deliberative Edition (审议版)**  
> Research line: V10-R2.1 optimized final. This branch focuses on provenance-bound semantic authority, higher-order SC relations, dependency-aware adjudication, and reproducible final-decision formation.  
> See [Deliberative Edition architecture](docs/deliberative-edition.md) and [reproducibility](docs/deliberative-reproducibility.md).

# Debate-Judge

### Structure-aware analysis and adjudication for competitive Chinese debate

[中文](README.zh-CN.md)

Debate-Judge is a research-software prototype for tracing how case structure, clash development, and adjudication interact across a debate. It combines staged LLM analysis, explicit intermediate representations, contract checks, recovery support, and a generated browser report.

**Current public status:** v0.1.2 Research Preview. Project code and engineering documentation use the repository MIT License; the frozen `Skill-Judge.md` rule/runtime text and its exact `Debate-Judge.md` mirror retain the `CC BY-NC-SA 4.0` notice embedded in that frozen source. The branch is publicly reproducible at the software level. No claim is made that the system is state of the art, human-equivalent, universally valid, or independently validated for adjudication quality.

## What is in this repository

There is one canonical rule/runtime source:

- `Skill-Judge.md` — the maintained canonical Skill and the single-file self-contained distribution.
- `Debate-Judge.md` — a byte-identical generated mirror retained in Deliberative Edition only because the frozen V10 bundle/runtime-identity contract consumes both names. Do not edit it directly.

The rest of the repository is implementation around that source:

- `pipeline-controller.js` — pipeline orchestration, validation, resume planning, and source synchronization.
- `executor/` — provider/runtime execution and contract validation.
- `schemas/` — machine-readable artifact contracts.
- `assets/` — report templates, CSS, dictionaries, and chart constants.
- `scripts/` — build, embedding, validation, release, and text-processing utilities.
- `web/src/` — maintainable browser source.
- `web/judge.html` — generated single-file browser distribution.
- `tests/` — rights/privacy-cleared public deterministic test suite.
- `MANIFEST.sha256` — checksums for the publishable source tree.

The branch does **not** version the `.claude/skills/.../SKILL.md` install target. The sole exception to the no-duplicate rule is the checked-in `Debate-Judge.md` mirror described above, retained for exact frozen-artifact reproducibility.

## Execution model

The current core declares ten execution units in `executor/core.js::ROUNDS`:

`R1 → R2 / R2.5 → R3 → R4 → R4.5 → R5A / R5B → R6a → R6b`

R7 plain-language output and R8 reader guide are optional post-processing stages. Dependency metadata and recovery logic should not be read as scientific evidence that the adjudication is correct.

## Quick verification

No npm install or third-party Node package is required for the current source tree.

```sh
node tests/run-deliberative-public.js
node scripts/secret-scan.js
node scripts/generate-manifest.js
```

`web/judge.html` is the exact frozen Deliberative browser artifact and is verified by SHA. The historical browser builder is retained for source lineage, but exact visual regeneration is not part of the public reproducibility claim because two quarantined Sanctum image inputs are intentionally excluded. Do not hand-edit the frozen artifact.

## Real adjudication

For a transcript you are authorized to use:

```sh
node pipeline-controller.js pipeline run /path/to/transcript.txt --provider auto --plain --reader-guide
```

Real adjudication calls an external model provider, may incur cost, and may send transcript content outside the local machine. Review provider settings and data permissions before running. Do not commit credentials, private transcripts, or generated private reports.

See [Usage](docs/usage.md) for provider and resume details.

## Research scope

The project focuses on four engineering/research questions:

- representing a side's case structure rather than treating a debate as a flat text;
- tracing clash as a developing process across speeches;
- making context-sensitive judging assumptions explicit;
- preserving inspectable intermediate artifacts and recovery state.

These representations are modeling choices. Software checks protect internal consistency; they do not establish adjudication accuracy, human agreement, benchmark superiority, or scientific validity.

Debate-Judge shares concepts and provenance with the broader Debate Universal Grammar / 辩论筑基 research program, but this repository is a bounded software implementation. Theory work, private audits, or frozen design records outside this repository are not automatically claims about the public runtime.

## Documentation

- [Installation](docs/installation.md)
- [Usage](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Reproducibility](docs/reproducibility.md)
- [Data and rights](docs/data-and-rights.md)
- [Support and governance](docs/support-and-governance.md)
- [AI usage disclosure practice](docs/ai-usage.md)
- [Public tests](tests/README.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Related research

Relevant neighboring work includes chronological and multidimensional LLM debate judging, argument-quality research, Chinese debate corpora, and LLM rubric calibration. Debate-Judge should be evaluated against such work through explicit experiments rather than priority claims.

## License and data boundary

Project-owned code, schemas, tests, engineering documentation, and code-only assets are released under the [MIT License](LICENSE). The frozen `Skill-Judge.md` rule/runtime text and its exact `Debate-Judge.md` mirror retain their embedded `CC BY-NC-SA 4.0` notice; generated single-file artifacts that embed that text therefore carry a mixed-license boundary. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records the boundary and scholarly attributions.

The repository does not distribute real competition transcript corpora, course media, model weights, provider credentials, private adjudication outputs, or the earlier quarantined Sanctum artwork.

## Citation / JOSS

This is a public research-software preview, not a JOSS publication. Public development history starts from the actual GitHub history beginning 7 September 2026. Citation metadata, archival DOI, and a JOSS paper should be added only when the corresponding release and research evidence actually exist.
