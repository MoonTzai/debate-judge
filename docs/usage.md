# Usage

Debate-Judge can be inspected and software-tested without calling an external model. Real adjudication requires an explicitly configured provider and an input transcript that you are authorized to use.

## Software-only checks

```sh
node install-skill.js --verify-only
node web/build-judge-web.js
node tests/run-public.js --current
```

These commands are the public release integrity path. They do not measure judging quality.

Run `node tests/run-public.js` for the complete public status, including inherited failures documented in [snapshot notes](semantic-edition.md).

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

Use the Chinese/English buttons in the header to change interface language, and the theme button to switch dark/light backgrounds. These controls do not change judging settings or translate source transcripts, generated reports, or raw evidence logs. Both background images are embedded; no separate download or image server is required. Narrow mobile work/reading screens retain the simpler background used for readability.

For an interrupted R8 run, import the complete session JSON in History and choose **Continue from last checkpoint** (继续最后断点), keeping the same model/settings. A matching saved private guide draft proceeds to independent review. An explicit restart from R8 invalidates that stage and regenerates the guide; it is different from ordinary continuation. R8 success still requires semantic review and, when enabled, plain-language processing.

If R8 has identified a substantive inconsistency in the report, continuation first asks the model to examine the original source and available analysis artifacts. The model can explain the objection as a note, request review by the responsible existing stage, or leave it unresolved. A review can regenerate upstream work and affected downstream outputs, incurring further API use. Old artifacts and the objection are retained; ordinary continuation does not repeatedly ask for approval of an unchanged unresolved issue.

The **Export Debug** button beside **Log / evidence** downloads one ZIP for the current session. It includes all currently captured UI log lines, session files, available formal/plain reports, settings, run metadata, persisted checkpoints and earlier saved versions, plus associated Flight requests and raw responses. Current memory and persisted data are kept separate. An active export is an intermediate observation; missing, truncated or inconsistent evidence is listed in the manifests. Export neither runs the model nor changes Judge/Flight storage. Credential fields and known configured keys are redacted in exported copies; transcripts and model outputs are still private material. For migration, use the included `session/session-export.json` when present, rather than the Flight archive alone.
