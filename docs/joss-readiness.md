# JOSS Readiness Tracker

Status: local candidate planning record. No JOSS submission, public-repository age, acceptance, DOI, or publication is claimed.

## Hard prerequisites before submission

| Area | Current candidate state | Required next evidence |
|---|---|---|
| OSI-compatible software license | **MIT / current rights boundary accepted** | Keep `THIRD_PARTY_NOTICES.md` current for future additions |
| Public development history | **Started 2026-09-07** | Maintain >6 months of genuine distributed public development; do not backdate or reconstruct history |
| Research use / impact | **Not yet established for JOSS** | Document real research use, citations/preprints, external use, or research-workflow integration |
| Maintainable software | **Local post-hardening acceptance green** | Publish the accepted source, then repeat from a fresh clone |
| Installation / local testing | **PASS locally on current candidate** | Repeat the same acceptance chain from a fresh external clone after push |
| Documentation | **MIT/rights boundary updated** | Refresh acceptance hashes/status after rebuild and first Git publication |
| Paper | **Not started as submission artifact** | Add JOSS `paper.md`/bibliography only when software scope, authorship, claims, and impact evidence are ready |
| Permanent archive | **Future** | After successful review/release stage, archive the tagged software version and record the version DOI |

## Public-development clock

The clock began on **7 September 2026**, from the actual public repository history. It does not inherit private file timestamps, local staging age, or reconstructed/backdated commits.

After publication, maintain an honest record of:

- substantive commits distributed through the six-month period;
- release/tag or changelog milestones;
- issues/discussions that reflect real maintenance;
- tests/CI improvements;
- documentation and contributor guidance changes;
- research-use evidence.

Do not manufacture PRs, contributors, issues, adoption, or historical dates to satisfy a checklist.

## Suggested version path

- `v0.1.0 Research Preview`: first rights-cleared public research-software baseline.
- Subsequent pre-1.0 releases: genuine engineering/research development during the public-history period.
- JOSS submission candidate: only after the software is feature-complete enough for review, public-history and impact gates are satisfied, and the paper claims map to reproducible evidence.

## Paper evidence discipline

Each paper claim should be classified as one of:

- implemented software capability;
- software test result;
- measured scientific result;
- external research use/impact;
- limitation or future work.

Do not use software self-checks as evidence of adjudication correctness. Do not use design-frozen/private audit records as if they were independently reproduced research results.

## Current blocking sequence

1. commit and push the deterministic Web-build fix that removes build-time timestamp injection;
2. perform fresh-clone rebuild/test/scan/manifest byte-equality acceptance;
3. continue genuine public development, releases, issues/tests/docs, and research-use evidence from the 2026-09-07 public-history start;
4. only pursue JOSS submission after the >6-month public-history and research-use/impact gates are genuinely mature.
