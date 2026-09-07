# Reproducibility

Debate-Judge separates **software reproducibility** from **scientific validation**.

## Software acceptance

The public deterministic acceptance path is:

```sh
node install-skill.js --verify-only
node pipeline-controller.js self-check
node tests/run-public.js
node web/build-judge-web.js
node scripts/secret-scan.js .
node scripts/generate-manifest.js
```

The release acceptance helper runs the same core checks through:

```sh
node scripts/accept-release.js --build
node scripts/accept-release.js --test
```

For v0.1.0, the repository was rebuilt and tested from a fresh public clone on Node v24.16.0 / Windows x64. A build-time timestamp that initially broke byte-level reproduction was removed before final acceptance.

`MANIFEST.sha256` is the current checksum authority for the publishable tree. `web/dist/` is a Git-ignored build/test intermediate; `web/judge.html` is the tracked generated browser artifact.

Future releases should repeat fresh-clone build/test/scan/manifest acceptance rather than copying old hashes into documentation.

## Scientific reproduction

Passing software checks does not reproduce an adjudication-quality result. Scientific evaluation requires a frozen software version, authorized data, a human/reference protocol, baselines, model/provider configuration, uncertainty/error analysis, and reproducible result artifacts.
