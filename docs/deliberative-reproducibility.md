# Deliberative Edition reproducibility

## Public reproducibility target

This branch reproduces the open-source **engineering mechanisms** of the frozen V10-R2.1 Deliberative Edition.

The public tree contains:

- runnable single-file Web Judge;
- the publishable runtime/adjudication source needed to inspect and exercise the Deliberative mechanisms;
- semantic authority / review / projection / final-adjudication code;
- zero-model and synthetic mechanism regressions;
- public edition attestation;
- source manifest and CI.

It intentionally excludes:

- copyrighted or third-party debate transcripts used in private evaluation;
- raw provider/API Flight recordings;
- private lifecycle/cutover authorization state;
- historical rollback trees and internal audit archives;
- two quarantined Sanctum UI images required by the historical V10 visual builder.

Those exclusions prevent data-rights leakage. The checked-in `web/judge.html` remains the exact frozen V10 final artifact, but the public tree does **not** claim byte-identical regeneration of that historical visual artifact because the quarantined UI images are intentionally absent.

## Frozen reference

- V10 optimized backup tree SHA-256: `cc4a310675e82e1efcfb77a2e49c31f6dcf4d060c7c7fc296b65433ebf25a348`
- final Web artifact SHA-256: `e392b5af98ecefefb70a3e8260d1376603bbb9e0d2b5e674647d2a2826eeba58`
- final runtime manifest SHA-256: `9f4a55d60a18b9a3af7510659b1b3a73e46d8fc235f655e3afaef674e34925ea`
- final ReportHost SHA-256: `5e13366712ab362355280ed557877e9378602568e1a189b9a05bc652187b8edd`

## Verify

```bash
node tests/run-deliberative-public.js
node scripts/secret-scan.js
node scripts/generate-manifest.js
```

For a completed run directory that you are authorized to use, the generic SC acceptance harness is available separately and intentionally requires an explicit work directory:

```bash
node tests/sc-semantic-authority-generic-acceptance.js <workDir>
```

It is not part of the zero-argument CI suite because this public branch does not distribute private real-debate run directories.

The test runner first requires the checked-in `web/judge.html` to match the frozen final SHA and fails if either quarantined Sanctum image is present. It then executes the public zero-model/synthetic mechanism suite. The historical `web/build-judge-web.js` is retained as lineage/source material, but exact visual rebuild is outside the public reproducibility claim because its two historical image inputs are intentionally excluded.

## Semantic-evaluation boundary

Passing this suite demonstrates reproducible implementation properties, not universal semantic correctness on unseen debates. Real-debate evaluation belongs in a separately governed dataset/evaluation package with appropriate redistribution rights.
