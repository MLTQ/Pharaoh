# prose.rs

Prose chapter → audio-drama Fountain, without rewriting the prose.

## Steps

1. `parse(text) -> Source` splits the chapter into ordered `Segment`s:
   narration and quoted speech (straight or curly quotes; an unclosed quote
   runs to the paragraph end). Markdown headings, `_Source:_`-style metadata,
   emphasis markers and rules are dropped; a rule (`---`, `* * *`) or heading
   after the start marks a section break. The first `# Heading` is the title.
2. A `Plan` attributes each quote (`LineAttr`: speaker, verb, delivery),
   places scenes (`SceneStart`) and cues (`CuePlan`: SFX/BED/MUSIC after a
   segment). `heuristic_plan` builds one from:
   - dialogue tags beside the quote ("Wren snapped", "said Pip");
   - pronoun tags ("he asked"), matched to the most recently named character
     whose pronoun (from the narration, `pronouns_of`) fits;
   - action beats naming one character ("Corvin dropped into the chair.");
   - the paragraph's earlier speaker, then turn-taking.
   It makes no cues; section breaks become scenes. `commands/prose_script.rs`
   asks Claude for a better plan.
3. `assemble(src, plan, cast, opts)` writes Fountain: the heading, NARRATOR
   blocks (split at sentences past ~450 chars), CHARACTER / (delivery) /
   line, and cue lines.

## Naming voices

With `intros` on, a character's first line in each scene is followed by the
narrator naming them — "Said Hagrid." / "Whispered Pip." (the line's verb) —
unless the narration right before or after the line (same paragraph) already
mentions them. If the next narration starts with a pronoun tag ("he muttered,
shaking his head"), that tag is read with the name instead ("Ron muttered,
shaking his head") so the listener doesn't hear two tags.

## Cast

`cast_from_names` gives each name its aliases: the full name without a
trailing parenthetical, plus words of the name that no other cast member
shares and that aren't titles ("Harry Potter (GOF)" → "harry potter",
"harry", "potter"). `short` — what the narrator calls them — is the alias the
prose uses most, in its own capitalisation. `discover_names` finds speakers
the prose tags or beats that the cast lacks, with their surname when the text
gives one ("Pip Holloway").
