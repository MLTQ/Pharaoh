# Attribution-row editing: generic adaptation case study

## Problem

A prose adaptation created many narrator dialogue rows consisting only of “said Mira,” “said Elias,” or “she said.” These were actual spoken takes, not structural metadata. Repetition consumed generation work and distracted from useful narration.

The lesson is editorial, not a generation failure: a row can synthesize correctly while contributing little to the listener's understanding.

## Detect candidates

Read compiled rows using the installed CLI. Configure the narrator identifier from the current cast instead of embedding one from another project. An illustrative filter:

```python
import json
import os
from pathlib import Path

project_dir = Path(os.environ["PROJECT_DIR"])
narrator_id = os.environ["NARRATOR_ID"]  # Obtain from this project's cast.
rows = json.loads((project_dir / "rows-review.json").read_text())
prefixes = ("said ", "she said", "he said", "thought ", "asked ", "replied ")
candidates = [row for row in rows
              if row.get("character") == narrator_id
              and row.get("prompt", "").strip().lower().startswith(prefixes)]
```

Adapt the JSON shape and field names to the installed version. This filter identifies review candidates, not automatic deletion targets: an attribution prefix can introduce important action.

## Editorial categories

- **Bare mechanical tags:** after the speaker is clear, merge into adjacent narration or remove if the adaptation brief permits it.
- **First-appearance identification:** “said Mira, from behind the counter” can establish an unfamiliar voice. First-appearance-only attribution is an optional convention, not a universal rule.
- **Narratively meaningful remarks:** keep business, changes in tone, or listener-relevant information. “Elias said, quieter now, surprising even himself” is more than a speaker label.
- **Interior framing:** retain sufficient cues to distinguish thoughts from spoken dialogue. “thought Mira” remains dry narrator speech; any interior treatment applies to Mira's thought take, not automatically to the framing tag.

Define treatment membership by intended speaker and narrative role, never spatial-flag state alone. A speaker can have both spoken and interior lines.

## Safe recompilation and rebinding

In tested Pharaoh versions, Fountain recompilation created fresh rows with empty file bindings and could reset placement/spatial fields. Re-check this behavior in the active version. Before compiling an edited scene, preserve the script, bindings, directions, cast mapping, and curated timing in project-managed backups.

After compilation:

1. Verify every character assignment against the intended cast/reference. Parenthetical cast variants can resolve ambiguously; do not trust a successful import alone.
2. Match unchanged rows using verified character identity, exact prompt, performance direction, and occurrence/context. A `(character, prompt)` key can help, but repeated identical text requires an occurrence-aware match.
3. If identifiers changed, establish an explicit validated cast mapping first. **Do not rebind by prompt alone:** identical words can belong to different speakers or performances.
4. Reuse only compatible existing assets whose files and provenance are valid. Changed text or delivery generally needs a new take.
5. Keep removed-row assets as unreferenced material unless a separate cleanup is authorized. Do not repurpose them merely because their words resemble another row.
6. Restore intended timing and spatial treatment. Offline-HRTF-processed files must not accidentally regain renderer spatial flags; see `production-notes.md`.
7. Read rows back, verify all required bindings and treatment fields, then relayout or repair timing, restore overlaps, render, and listen.

Use the installed version's documented script-write/edit interface; command availability and row schema are version-dependent. Preserve the authoring source and the read-back snapshot so future compiles can reproduce the intended result.
