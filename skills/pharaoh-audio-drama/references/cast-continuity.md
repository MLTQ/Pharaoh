# Voice continuity and thought framing: generic case study

This filename is retained for compatibility; the content is a portable case-study summary, not a record of a particular project or session.

## Adjacent takes can be individually good but jointly stilted

In a representative adaptation, Elias's lines “Spacious. Very cosy. Just me and the dust.” and “About my own height, too. That's convenient.” needed a continuous performance rather than two independently directed takes.

Reusable method:

1. Confirm the exact lines and the intended actor/reference. Do not switch actors to solve pacing.
2. Generate both lines as one performance with a shared direction grounded in the surrounding scene.
3. Retain the unsplit take as an audition/master asset in the configured `PROJECT_DIR`.
4. If separate rows are required, detect a natural inter-phrase pause and split at its midpoint or edges. Do not embed fixed split times from another take.
5. Bind the segments, recompute or repair layout, and choose an inter-row gap that complements the retained pause rather than doubling it.
6. Listen to the split join and the full scene. A successful render is not subjective approval.

## Thought audio and narrator tags have separate roles

If Mira's first thought is followed by “thought Mira,” the thought may receive an agreed interior treatment while the narrator tag stays dry by default. A request for a “thinking effect” does not imply that narration inherits it; clarify only if the requested scope genuinely remains ambiguous.

When binding an offline-processed thought take, clear renderer spatial flags if processing replaces spatialization. Verify speaker AND narrative role before choosing rows. See `production-notes.md` and `interior-voice-treatments.md`.

## Cast-variant ambiguity

In tested Fountain imports, a cue such as `ELIAS (YOUNG)` could be parsed as the bare name plus an extension, then resolve to another Elias variant. This is a tested-version hazard, not universal parser behavior.

Inspect exact character assignments and reference provenance after import and after every recompile. Prefer unambiguous cue names where supported. Correct the mapping through a documented script-edit/write interface and read it back before generation. A clean dry run does not certify actor identity.

## Adaptation boundaries and mix revisions

Preserve the supplied excerpt's stopping point; do not invent continuation unless asked. New preset/designed roles need an audition before being treated as locked. Existing cloned roles should retain their approved references.

For a request to lower music slightly, inspect current gain and make a modest auditioned adjustment; do not replay a historical absolute value. Supporting effects should overlap relevant speech where intended and remain subordinate to intelligibility. Crossfade duration and loudness targets are optional production choices, not required settings.

All asset locations derive from `PROJECT_DIR`; CLI execution uses the configured `PH`. No project identifiers, original actors, or prior session state are needed to apply these lessons.
