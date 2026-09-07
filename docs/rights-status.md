# Rights and License Status

Status: **release review record, not a license grant or legal opinion**.

The public candidate now contains a top-level MIT `LICENSE`. On 7 September 2026 the project right holder explicitly authorized MIT relicensing for Debate-Judge material they have authority to license. A targeted source scan found no bundled long-form third-party publication, competition-handbook, or course-media excerpt; named scholarly concepts remain attributed rather than being treated as project-owned theories. The two Sanctum background images with unresolved redistribution authority were removed from the public closure and moved to private rights quarantine.

| Material class | Candidate examples | Current provenance confidence | Public-license status |
|---|---|---|---|
| Program code | root JS, `executor/`, `scripts/`, `web/src/`, build scripts | project-owned/public candidate; targeted scan found no explicit bundled third-party source marker | **MIT**; future third-party additions require separate review |
| Schemas / CSS / HTML skeleton | `schemas/`, `assets/report.css`, `assets/skeleton.html` | project source closure; no explicit incompatible source marker found in the release scan | **MIT** |
| Canonical Skill / rule text | three Markdown distribution mirrors | project-owned expression with scholarly concept names/short project summaries; targeted scan found no long-form external copied source | **MIT**; frontmatter updated, scholarly attribution retained in `THIRD_PARTY_NOTICES.md` |
| Public-candidate documentation | README, CONTRIBUTING, CHANGELOG, `docs/`, test documentation | written specifically for the public-candidate preparation | **MIT** under repository license |
| Public test code | `tests/run-public.js` and selected source-integrity tests | selected to exclude private evidence/real-output fixtures | **MIT** |
| Sanctum UI artwork | earlier `sanctum-dark.webp`, `sanctum-light.webp` | provenance preserved privately; redistribution authority not needed for current release | **EXCLUDED from public distribution**; Web UI now uses project-authored CSS gradients |
| Generated browser artifact | `web/judge.html` | regenerated from the MIT/CSS source closure | **MIT**; current post-hardening build accepted |
| Real transcripts / outputs / course media | intentionally absent | private or third-party provenance varies | **Excluded unless separately cleared** |

## Remaining release closure

Rights/licensing preference and the current public source boundary are closed for the candidate: MIT is granted for project-owned content; scholarly attributions are recorded; unresolved artwork is excluded. Post-hardening engineering re-acceptance is also GREEN: browser rebuild, public test suite, executable secret scan, path/privacy postconditions, and manifest generation all passed on the current source. The next gate is Git bootstrap/publication followed by fresh-clone acceptance.

Any future copied/adapted prose, dataset, fixture, media, font, vendor code, or artwork reopens a file-level rights review.

## Important boundary

A permissive LICENSE placed at repository root cannot override third-party rights or a conflicting license already attached to embedded material. Likewise, publishing the repository does not by itself grant OSI-compliant reuse rights.
