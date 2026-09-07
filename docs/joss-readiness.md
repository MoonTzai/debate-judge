# JOSS Readiness Tracker

Status: local candidate planning record. No JOSS submission, public-repository age, acceptance, DOI, or publication is claimed.

## Hard prerequisites before submission

| Area | Current candidate state | Required next evidence |
|---|---|---|
| OSI-compatible software license | **MIT / current rights boundary accepted** | Keep `THIRD_PARTY_NOTICES.md` current for future additions |
| Public development history | **Not started** | Publish the real repository and maintain >6 months of distributed public development |
| Research use / impact | **Not yet established for JOSS** | Document real research use, citations/preprints, external use, or research-workflow integration |
| Maintainable software | **Local post-hardening acceptance green** | Publish the accepted source, then repeat from a fresh clone |
| Installation / local testing | **PASS locally on current candidate** | Repeat the same acceptance chain from a fresh external clone after push |
| Documentation | **MIT/rights boundary updated** | Refresh acceptance hashes/status after rebuild and first Git publication |
| Paper | **Not started as submission artifact** | Add JOSS `paper.md`/bibliography only when software scope, authorship, claims, and impact evidence are ready |
| Permanent archive | **Future** | After successful review/release stage, archive the tagged software version and record the version DOI |

## Public-development clock

The clock begins from the **actual public repository history**, not from this local staging directory, private file timestamps, or reconstructed/backdated commits.

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

1. regenerate `MANIFEST.sha256` after the final documentation updates and freeze the accepted hashes;
2. initialize the nested Git repository and create the first honest local commit;
3. create/publish the public GitHub repository with the already stated publication intent;
4. perform fresh-clone rebuild/test/scan acceptance;
5. accumulate genuine public development history and research-use/impact evidence before JOSS submission.
