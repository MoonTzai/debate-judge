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
node web/build-judge-web.js
node tests/run-public.js --current
```

These are software-integrity checks, not adjudication-quality measurements.

The full runner (`node tests/run-public.js`) also reproduces known legacy failures. See [snapshot notes](semantic-edition.md); the old `pipeline-controller.js self-check` is not a passing release gate for this frozen candidate.

## Browser artifact

`web/judge.html` is generated from source:

```sh
node web/build-judge-web.js
```

Do not repair generated HTML by hand.

## Skill / Agent installation

`Skill-Judge.md` is the only canonical Skill source in the repository.

`install-skill.js` can verify the embedded closure, extract a runnable workspace, and generate a lightweight user-level Skill shell. This frozen branch preserves identical `Debate-Judge.md` and `.claude/skills/debate-judge/SKILL.md` compatibility mirrors. The root `Skill-Judge.md` remains the canonical source.

Verification only:

```sh
node install-skill.js --verify-only
```

Normal installation writes to the configured user Skill destination and extraction workspace. Review those destinations before running it.

## Credentials

Never put credentials in the repository. The runtime accepts environment configuration or a local `.api-config.json`; that file is Git-ignored and must remain local.
