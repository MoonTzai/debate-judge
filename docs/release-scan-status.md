# Release Scan Status

Snapshot date: 2026-09-07.

Status: **static and executable candidate scans completed; no secret/private-path blocker found**.

## Intended remote identity

The currently authenticated GitHub identity was fresh-read from an existing Git repository through FolderBridge:

- owner: `MoonTzai`
- intended repository: `debate-judge`
- intended future URL: `https://github.com/MoonTzai/debate-judge`

The `debate-judge` repository has **not yet been created or published**. This document records the intended remote identity only.

## Candidate inventory

After MIT/rights hardening, synchronization, rebuild, and the final Git-tree normalization, the publishable candidate contains 83 non-manifest entries plus `MANIFEST.sha256`. `web/dist/judge-bundle.js` and `web/dist/.inputs.json` are reproducible test/build intermediates and remain intentionally Git-ignored; they are rebuilt locally but are no longer part of the release manifest. The tracked generated deliverable is `web/judge.html`. The two quarantined Sanctum WebPs are absent. Use the manifest file itself as the final hash authority.

## Credential scan

Static literal scans covered representative/high-risk forms corresponding to the bundled secret scanner:

- `sk-`
- `ghp_`
- `github_pat_`
- `AKIA`
- `GITHUB_TOKEN`
- `_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `Bearer `

Findings:

- no actual GitHub PAT or AWS-style key value was found;
- `sk-` hits are CSS class names, password-input placeholders such as `sk-...`, or redaction/secret-scan regex source;
- `Bearer ` hits construct authorization headers from runtime variables or define redaction/scan regexes; no literal bearer token was found;
- provider credential names occur as environment-variable identifiers, not committed credential values;
- no `.api-config.json`, `.env`, private key, or auth-config instance is present in the candidate file list.

Executable scan was rerun from `Debate-Judge-Public/` after the MIT/CSS source synchronization and browser rebuild. Result: `PASS：未发现密钥风险（84 个文件）`.

## Local/private path scan

Static path/privacy scans included:

- `C:/Claude`
- `C:\\Claude`
- `C:/Users`
- `C:\\Users\\`
- `Upload/Wayfinder`
- private design-path references
- common personal email domains

Findings:

- hardened canonical source and public tests contain no fixed private project root;
- the one `C:\\Claude` test hit is a negative assertion that forbids that path;
- regenerated `web/judge.html` contains the hardened current source snapshot; fresh searches found no fixed `C:/Claude/Project/Debate-Judge` or backslash-equivalent private root;
- public documentation deliberately names private evidence categories only to explain exclusions; this is not a runtime dependency;
- no `@gmail.com`, `@outlook.com`, or `@qq.com` address was found.

## Current scan status

The generated-artifact/path blocker remains closed on the current post-hardening build. Fresh acceptance found no fixed private project root in runtime-sensitive source/generated content, no real personal-email value, no actual credential instance, no `.api-config.json` instance, and no copied private Wayfinder/Output fixture. The canonical/generated Skill now carries MIT, and the quarantined Sanctum artwork is absent from the public closure. Literal hits for private evidence categories, credential variable names, authorization-header construction, or email domains are documentation exclusions, runtime-variable construction, redaction rules, or negative scan assertions rather than embedded secrets.

Before any future public push, rerun:

1. `node scripts/secret-scan.js .`
2. `node tests/run-public.js`
3. candidate path/privacy scans
4. fresh `MANIFEST.sha256`
