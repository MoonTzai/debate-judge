# Installation

## Requirements

- Node.js with built-in `fetch`, `AbortController`, streams, `TextEncoder`, and the Node test runner.
- A modern browser for `web/judge.html`.
- An external model service only for real adjudication.

The current repository has no npm dependency installation step.

## Verify a clone

From the repository root:

```sh
node install-skill.js --verify-only
node pipeline-controller.js self-check
node tests/run-public.js
```

These are software-integrity checks, not adjudication-quality measurements.

## Browser artifact

`web/judge.html` is generated from source:

```sh
node web/build-judge-web.js
```

Do not repair generated HTML by hand.

## Skill / Agent installation

`Skill-Judge.md` is the only canonical Skill source in the repository.

`install-skill.js` can verify the embedded closure, extract a runnable workspace, and generate a lightweight user-level Skill shell. The repository itself does not keep duplicated Claude/Codex Skill copies.

Verification only:

```sh
node install-skill.js --verify-only
```

Normal installation writes to the configured user Skill destination and extraction workspace. Review those destinations before running it.

## Credentials

Never put credentials in the repository. The runtime accepts environment configuration or a local `.api-config.json`; that file is Git-ignored and must remain local.
