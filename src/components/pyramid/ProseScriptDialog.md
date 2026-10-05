# ProseScriptDialog.tsx

"From prose…" on the Pyramid's new-scene form. Paste a chapter or open a
.txt/.md file, pick the narrator (defaults to a cast member named like
"Narrator"), choose whether the narrator names each voice on its first line in
a scene and whether Claude plans it, then Convert (`proseToScript`). The
result is editable Fountain with counts, new speakers and any `UNKNOWN` lines
flagged. "Add N scenes" runs `importScriptText` and reloads the project.
