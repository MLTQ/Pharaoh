# Source-to-performance contract

## Failure this prevents

A director can receive a complete scene and still miss literal delivery requirements. In a representative case, Mira's source attribution required a whisper and a later shout, but the directions described clenched teeth and forceful intent without naming either delivery. A vocal-event tag alone did not guarantee the requested sound. This is a delivery mismatch, not proof of a synthesis-engine defect.

Extract explicit source requirements before adding artistic interpretation.

## Context packet for a directing agent

Supply the full scene, cast/reference constraints, and these instructions:

> Read each quote AND its attached attribution, even when the attribution follows the quote. Read adjacent action/reaction and neighboring turns. Extract explicit vocal delivery before interpreting mood.
>
> Whispered, shouted, muttered, stammered, screamed, sobbed, gasped, and similar descriptions constrain the character's performance. Put the required delivery explicitly at the START of the synthesis instruction. Then add context-grounded emotion, physical state, and a concise breath/tempo/pitch trajectory.
>
> Do not substitute metaphors, playback gain, punctuation, or a vocal-event tag for that instruction. Narrator attribution stays narrator speech: its delivery description governs the character's line, not the narrator's take. Scope each requirement to its actual beat; do not spread a whisper or shout across a scene without source support.
>
> Separate source evidence from inferred mood. A whisper does not necessarily imply fear or secrecy. Flag conflicting constraints rather than silently dropping either. Re-read source and dialogue together before generation.

Keep a per-line planning record outside spoken text:

- **Source evidence:** delivery verb, physical action, nearby reaction.
- **Required delivery:** whisper/shout/ordinary speech/etc.; explicit source constraints are acceptance requirements.
- **Inferred state:** emotion, fatigue, objective; label inference.
- **Performance:** delivery + mood + breath/tempo/pitch movement.
- **Mix role:** foreground dialogue, thought, remembered speech, supporting effect.
- **Acceptance:** what a listener must hear, not merely what metadata must contain.

## Fictional examples

### Mira whispers: “Open the latch.”

- Evidence: the source says she whispers through gritted teeth after repeated failed attempts.
- Required delivery: whisper throughout the line.
- Inferred state: exhausted frustration; not automatically furtiveness.
- Instruction:

  `Whisper the entire line, breathy and unvoiced rather than normal quiet speech. Exhausted and desperately frustrated; jaw tight, careful clipped syllables, pushing for the latch to open, then leave a small expectant breath.`

- A supported `[whispers]` tag can supplement the instruction.
- Acceptance: unmistakable whispered texture, not ordinary speech turned down.

### Elias shouts: “Enough delays. Enough excuses. Open the door!”

- Evidence: the source explicitly says he shouts, knocks books aside, and provokes a nearby listener's request for quiet.
- Required delivery: audible shouting/outburst with escalating force.
- Inferred state: exhausted anger, venting rather than polished declamation.
- Instruction:

  `Shout this outburst, not normal conversational speech. Exhausted, anguished anger; bite each Enough harder, build breath pressure across the list, and explode on Open the door, with a strained edge rather than a polished stage voice.`

- Acceptance: audible projection/strain and escalation. Playback gain alone is not shouting.
- Do not invent a `[shouts]` event without checking the active engine's supported tags.

## Two checks, not one

1. **Before synthesis:** verify every explicit delivery requirement appears on the correct character row. Inspect compiled instructions and the generated take's recorded `instruct`, not only the authoring file.
2. **After synthesis:** assess acoustic delivery separately from transcript QA. An ASR engine such as Whisper checks words; its name does not imply it checks whispering. A take can have zero word error and still use the wrong delivery. Metadata proves an instruction was submitted, not obeyed.

Regenerate audibly wrong takes with the same actor/reference, clearer direction, and—where supported—direction-strength controls or an appropriate reference from that actor's palette. Do not silently replace whisper/shout performance with gain changes.

If no listening-capable reviewer is available, mark delivery QA **unreviewed**. Automated delivery judging requires the actual take, source evidence, and validated acceptance tests; text-only checks cannot certify performance. No whisper/shout classifier is assumed to exist.

Engine behavior and tag support are version-dependent. Check the configured installation's documentation before relying on a specific tag or control.
