# Third-Party Notices and Scholarly Attributions

This file records third-party boundaries for the Debate-Judge public distribution.

## Repository license boundary

The repository's project-owned code, schemas, tests, engineering documentation, and code-only assets are released under the MIT License, subject to the ordinary rule that a project cannot grant rights it does not own.

The frozen `Skill-Judge.md` rule/runtime text and its byte-identical `Debate-Judge.md` mirror retain the `CC BY-NC-SA 4.0` notice embedded in that frozen source. Generated single-file artifacts that embed this text inherit a mixed-license boundary; users should preserve both notices when redistributing the combined artifact.

The public repository does **not** vendor a third-party debate corpus, course media, model weights, proprietary SDK, or third-party UI artwork.

## Scholarly concepts referenced by name

The rule text uses short names or project-authored summaries of concepts associated with established scholarship, including:

- Stephen Toulmin — argument structure / field dependence;
- Kenneth Burke — terministic screens;
- J. L. Austin and John Searle — speech acts;
- H. P. Grice — implicature and meaning in use;
- Ludwig Wittgenstein — meaning/use;
- Chaïm Perelman — audience distinctions.

These references are scholarly attribution and conceptual vocabulary. The repository's MIT License applies to the MIT-licensed implementation/documentation portion described above; the frozen Skill text follows its file-level notice. Neither license purports to license third-party theories, publications, trademarks, or other independently owned works.

No long-form quotation, book chapter, article text, competition handbook, or course-media excerpt was identified in the public Skill during the 2026-09-07 release-rights scan. If such material is introduced later, it must be separately cleared, attributed, or rewritten into project-owned expression before release.

## Provider and standards identifiers

Public API endpoint examples, provider/model names, SVG/XML namespace identifiers, and JSON Schema identifiers are interoperability or standards references. They do not indicate that third-party SDK source or provider-owned documentation is bundled in this repository.

## Excluded UI artwork

Two earlier Sanctum background derivatives were removed from the public distribution during rights hardening:

- `sanctum-dark.webp`
- `sanctum-light.webp`

They remain in private provenance quarantine and are not required by the public build. The public UI now uses programmatic CSS backgrounds.

## Future additions

Any new fixture, dataset, screenshot, model output, media file, font, vendor code, or copied/adapted prose must receive a provenance and license review before entering a public release.
