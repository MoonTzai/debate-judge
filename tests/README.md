# Public Tests

Run the public deterministic suite from the repository root:

```sh
node tests/run-public.js
```

The runner performs:

1. embedded-closure verification through `install-skill.js --verify-only`;
2. `pipeline-controller.js self-check`;
3. Web-source syntax checks;
4. single-file parity checks;
5. selected deterministic runtime and source-integrity tests.

Current suites include:

- `self-check.test.js`
- `single-file-parity.test.js`
- `wayfinder-runtime.test.js`
- `slicing-contract.test.js`
- `rounds-source.test.js`
- `dictionary-consistency.test.js`
- `key-engine.test.js`
- `dead-assets.test.js`

A PASS supports source-closure, syntax, runtime-contract, deterministic ABI, and release-hygiene claims. It does **not** establish adjudication accuracy, human agreement, benchmark superiority, research impact, or independent scientific validation.

The private development project has broader evidence-dependent tests that are not redistributed merely to increase the public suite count. Any new public fixture must first be cleared for copyright, privacy, personal data, and local-path leakage.
