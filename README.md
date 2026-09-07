# Debate-Judge

### Structure-aware analysis and adjudication of competitive Chinese debate

[中文](README.zh-CN.md)

> Local public-candidate snapshot, 7 September 2026. Project-owned code, rule text, documentation, tests, and generated artifacts are prepared under the repository MIT License. A targeted rights scan found no bundled long-form third-party publication/handbook/course excerpt; the two previously uncertain Sanctum background images were removed from the public closure. The post-hardening source has now completed a fresh rebuild, public test suite, executable secret scan, path/privacy postconditions, and manifest regeneration. Git/publication and fresh-clone reproduction are now complete; JOSS public-history/impact requirements remain time- and evidence-dependent. No benchmark superiority or independent scientific replication is claimed.

Debate-Judge investigates how an LLM-based adjudicator can connect a team's case, the development of clashes across speeches, and a context-sensitive final judgment. It combines explicit domain representations and staged LLM analysis with machine-readable intermediate artifacts, contract checks, and a browser report.

The research focus is **the connection between argument structure, interaction, and judgment**, rather than the number of model calls or the visual richness of a report.

## Research focus

- **Case-level reasoning.** Represent the object, mediating reason, and conclusion using the project's A→B→C notation, including the central reason supporting a side's case. This is a domain representation, not a claim that natural-language argument validity is mechanically decidable.
- **Clash as a developing process.** Track how an opponent's argument is received, challenged, accommodated, or redirected across speeches. The inspected version uses an SC process model; its labels and thresholds are modeling choices that require external evaluation.
- **Context-sensitive adjudication.** Make judging perspectives and context explicit instead of treating every debate as an identical scalar-rating task. Model-generated audience assessments are not measurements of actual audiences.
- **Traceable outputs.** Preserve intermediate analyses, structured representations, conflict resolution, and report artifacts for inspection. Such traces support auditing; they are not, by themselves, proof that an explanation faithfully represents the model's reasoning.

## Implemented workflow in the inspected version

| Stage | Purpose |
|---|---|
| R1 | Extract case structure and clashes |
| R2 / R2.5 | Trace structural confrontation and analyze cross-side rhetoric |
| R3 | Synthesize the judgment |
| R4 / R4.5 | Produce structured output and resolve registered inconsistencies |
| R5A / R5B | Produce report narrative |
| R6a / R6b | Produce charts and assemble the report |
| Optional R7 / R8 | Produce a plain-language rendition and reader guide |

The core has ten execution units, as declared by `executor/core.js::ROUNDS`; R7 and R8 are separate post-processing stages. Grouped rows above describe responsibilities, not guaranteed concurrent execution. Dependency metadata must not be presented as evidence of an implemented parallel scheduler.

The inspected application is delivered as `web/judge.html`, containing browser code and embedded resources. A single-file interface does **not** imply offline model inference: real adjudication uses a configured external model service. Post-processing status should be distinguished from the core judgment's status.

## Relationship to Debate Universal Grammar (DUG)

DUG and Judge share a domain and related concepts, but their research contributions are not interchangeable:

| Research route | Question | Judge's bounded role |
|---|---|---|
| P1: programmatic theory | How can local arguments, case structures, interaction, and institutional judgment be represented together? | An engineering feasibility example; not validation of the entire theory |
| P2: knowledge-formalization methodology | How can heterogeneous teaching materials become a traceable expert knowledge system? | An execution-end case in the source-to-system pipeline |
| P3: corpus and annotation research | Can the proposed distinctions be reliably annotated and evaluated? | A candidate baseline and analysis tool; human agreement and results remain to be measured |
| Prospective Judge study | Does structure-aware adjudication improve grounded analysis or judgment under a specified setting? | The system under evaluation; a separate empirical contribution |

Current DUG theory revisions and the Wayfinder redesign are work with their own version and review status. They must not be advertised as fully implemented in this browser artifact. In particular, the Wayfinder design-freeze record does not establish runtime implementation or empirical effectiveness.

## Research status and limitations

The inspected materials establish a substantial research prototype with explicit prompts, intermediate formats, runtime checks, and reporting components. They do not establish an independently reproduced accuracy result, state-of-the-art performance, human-level judging, or a universal theory of debate.

Important limitations include model dependence, interpretation errors, uncalibrated domain heuristics, transcript-only evidence, and possible disagreement among qualified human judges. Structural validity, institutional match outcome, audience persuasion, and educational usefulness are different evaluation targets. Model self-review and passing software checks cannot substitute for independent human assessment.

As of the post-hardening acceptance on 7 September 2026, the three public-candidate Markdown distribution mirrors (`Skill-Judge.md`, `Debate-Judge.md`, and `.claude/skills/debate-judge/SKILL.md`) are byte-identical at SHA-256 `81863147ed0a9833e1380e92e631022b5b5c63157822c874f981c5d30413ba09`, with MIT frontmatter. The reproducible `web/judge.html` is SHA-256 `326d9156d61b071a66b4d9d4a323e72a99078fee04e778f4b38edc46612234dd`; two consecutive local rebuilds produced the same hash. `tests/run-public.js` ended with `PUBLIC TEST SUITE PASS`; the executable secret scan passed across 84 scanned files; and all release postconditions (mirror equality, MIT propagation, artwork exclusion, private-path exclusion, no API-config instance) passed. The public GitHub repository was established on 7 September 2026. Deterministic-build commit `be93dde964f6a236102cb73003e8799fa8ab9181` passed a fresh-clone rebuild/test/scan with byte-identical `web/judge.html` and `MANIFEST.sha256` (`cb678f81fff7f083eaa46c5fe08628061482048df91dd4da9f68a544f3ba2ab3`).

## Using the reviewed local candidate

The entry points below were executed locally and again from a fresh clone of the public repository using Node v24.16.0 on Windows x64.

From a reviewed source distribution, inspect the browser entry `web/judge.html`. The existing Node entry points include:

```sh
node pipeline-controller.js self-check
node tests/run-public.js
```

These are software checks, not scientific evaluation. `tests/run-public.js` is the public, rights/privacy-cleared subset; it is not the private upstream all-tests runner. Run tests in an isolated copy because they may create temporary or generated files. Current local and fresh-clone Node acceptance is v24.16.0 on Windows x64. Future releases should repeat the same acceptance and record any dependency/runtime changes.

For an authorized transcript, after explicitly configuring a supported model provider:

```sh
node pipeline-controller.js pipeline run /path/to/authorized-transcript.txt --provider auto --plain --reader-guide
```

This performs external model calls, may incur charges, and may send transcript content to the configured service. Review provider settings, data permissions, and output handling first. Do not commit credentials or private reports. Omit optional post-processing flags when those outputs are not required. No API execution is included in this preparation.

## Developer and release documentation

- [Installation](docs/installation.md)
- [Usage](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Reproducibility](docs/reproducibility.md)
- [Data and rights boundary](docs/data-and-rights.md)
- [Rights and license status](docs/rights-status.md)
- [Research impact evidence tracker](docs/research-impact.md)
- [Release scan status](docs/release-scan-status.md)
- [Support and governance](docs/support-and-governance.md)
- [AI usage disclosure practice](docs/ai-usage.md)
- [JOSS readiness tracker](docs/joss-readiness.md)
- [Public test documentation](tests/README.md)
- [Public test status](PUBLIC-TEST-STATUS.md)
- [Current release blockers](RELEASE-BLOCKERS.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Related research

[Debatrix](https://aclanthology.org/2024.findings-acl.868/) already studies chronological and multidimensional LLM debate judging. [Argumentation quality research](https://aclanthology.org/E17-1017/) provides prior multidimensional theory and annotation. [CEDAR](https://aclanthology.org/2026.acl-long.238/) provides Chinese debate transcripts and multiple labels. [LLM-Rubric](https://aclanthology.org/2024.acl-long.745/) illustrates calibration against human judgments. Judge's proposed distinctions require direct comparison with these neighboring approaches; this README claims neither priority over them nor superior results.

## Licensing, data, and citation

The current public candidate includes an MIT `LICENSE`; the canonical Skill frontmatter is also MIT. `THIRD_PARTY_NOTICES.md` records scholarly attribution and the boundary that MIT licenses Debate-Judge's own implementation/expression, not independently owned theories or publications. Real transcripts, course media, datasets, model weights, private outputs, and the quarantined Sanctum artwork are not part of this public distribution.

No course media, match transcript corpus, participant data, model weights, or provider credentials are included in this documentation package. Public accessibility of a source is not permission to redistribute it. Any future examples must carry their own provenance and rights statement.

Verified authorship, a release identifier, citation metadata, and any archival DOI will be added after approval and actual release. No publication, acceptance, or DOI is asserted here. Cite the specific software version for reproducibility and the relevant paper for its academic contribution once those records exist.
