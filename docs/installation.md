# Installation

Status: local public-candidate instructions validated in `Debate-Judge-Public/`; repeat from a fresh external clone before release.

## Requirements

- Node.js with the standard APIs used by this source tree, including built-in `fetch`, `AbortController`, streams, `TextEncoder`, and the Node test runner.
- A modern browser for `web/judge.html`.
- An external model service only when running real adjudication. Software verification and the public source-integrity suite do not require a paid model call.

No `package.json`, npm install step, Docker image, or third-party Node dependency is currently required by the candidate source. Do not add one merely for appearance; if future dependencies are introduced, they must be declared and pinned normally.

Current local acceptance used Node v24.16.0 on Windows x64 (`win32`, OS release `10.0.26200`). A modern-browser smoke should be recorded again from the eventual fresh public clone before release.

## Verify the source distribution

From the repository root:

```sh
node install-skill.js --verify-only
node tests/run-public.js
```

The public runner invokes the project self-check, Web-source syntax checks, and selected deterministic source/runtime tests. A PASS is software-integrity evidence, not adjudication-quality evidence.

## Browser artifact

The single-file browser artifact is:

```text
web/judge.html
```

For a release, it must be generated from the same public source tree with:

```sh
node web/build-judge-web.js
```

Do not hand-edit the generated HTML to repair source/artifact drift.

## Agent/Skill distribution

`Skill-Judge.md` is the canonical rule/runtime distribution source. `Debate-Judge.md` and `.claude/skills/debate-judge/SKILL.md` are byte-identical distribution mirrors.

To validate the embedded extraction closure without installing a user-level shell:

```sh
node install-skill.js --verify-only
```

A normal installer run can write an extracted workspace and a local Codex skill shell. Review the destination and local environment before doing that; verification alone is the safer release-check command.

## Credentials

Do not put credentials in the repository. The runtime can consume environment variables or an explicitly supplied local `.api-config.json`; that configuration file is ignored by the candidate `.gitignore` and must remain local.
