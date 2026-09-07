# Usage

Debate-Judge can be inspected and software-tested without calling an external model. Real adjudication requires an explicitly configured provider and an input transcript that you are authorized to use.

## Software-only checks

```sh
node install-skill.js --verify-only
node tests/run-public.js
```

These commands are the public release integrity path. They do not measure judging quality.

## Real adjudication entry point

```sh
node pipeline-controller.js pipeline run /path/to/authorized-transcript.txt --provider auto --plain --reader-guide
```

The current pipeline has ten core execution units; R7 plain-language output and R8 reader guide are optional post-processing.

Real execution may incur substantial model cost and sends transcript content to the selected external service. Review provider data handling, authorization, and cost before running it.

## Provider configuration

The shared provider layer supports these current modes:

- `auto`: resolves an explicitly selected provider or detects configured Anthropic-compatible / OpenAI-compatible credentials;
- `openai-compatible`;
- `anthropic-compatible`;
- `mock`: local/testing path where a mock responder is supplied;
- `codex-cli`: host-assisted local CLI path;
- `claude-task`: host-assisted callback path.

For `auto`, the current environment detection uses:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_MODEL

or

OPENAI_BASE_URL
OPENAI_API_KEY
OPENAI_MODEL
```

The OpenAI-compatible path can also use `EXECUTOR_BASE_URL`, `EXECUTOR_API_KEY`, and `EXECUTOR_MODEL`. Provider/model limits and endpoint behavior vary; they are not part of the repository license.

A local `.api-config.json` exported by the browser configuration UI can override applicable provider fields. Never commit that file.

## Outputs

The runtime creates a per-run output directory and keeps intermediate artifacts, structured outputs, report HTML, and recovery metadata there. Real `Output/` directories are excluded from the public repository.

## Resume behavior

For ordinary continuation of an existing authorized run, reuse the existing output directory without `--force`. For an explicit restart from a named logical stage, first use the read-only resume planner and follow its returned effective start/invalidated/preserved nodes. Do not manually delete intermediate artifacts to force a partial rerun.

## Browser use

`web/judge.html` is a generated standalone browser interface, but “single-file” does not mean model inference is offline. It embeds the application resources while real model requests still use the configured external provider.
