# Pharaoh Audio Drama Skill

A portable agent playbook for creating audio dramas with Pharaoh: prose adaptation,
voice casting, source-grounded acting direction, take generation, mixing, review,
and delivery. No source stories, recordings, model weights or voices are bundled.

## Prerequisites

- A working Pharaoh installation and its current CLI documentation.
- The speech/effects/music services required by your production. Configure their
  actual local or remote URLs in Pharaoh; do not assume fixed ports or hardware.
- FFmpeg and FFprobe for rendering and verification; Python 3 for the optional
  read-only capability probe (standard library only).
- Source material and voice references you are entitled to use.
- For directed speech, a backend that supports performance instructions. Breeze
  TTS 2 supports direction and vocal events; other backends may not. Check model
  licences separately from this skill's licence, including commercial-use limits.
- For SOFA/HRTF processing, a compatible dataset and FFmpeg's sofalizer filter.
  Ordinary non-spatial production does not require this optional treatment.

This skill does not install Pharaoh. From a Pharaoh checkout, start with the
repository's main README and docs/cli.md. Commands in the skill are examples
for the documented CLI; verify behavior against your installed version.

## Install into an agent

This folder ships as `skills/pharaoh-audio-drama/` in the Pharaoh repository.
Copy the **whole folder**, including references and scripts, into your agent's
skill directory, or point an agent supporting external skill folders at it.
For Hermes, use the skill directory associated with the profile you intend to
use; consult current Hermes documentation rather than modifying other profiles.
For other agents, load SKILL.md and retain access to its relative reference files.
The production guidance is not tied to a particular chat platform.

## Configure paths

Define paths for your own installation; no fixed home directory is required.
These are example shell-variable names, not automatic Pharaoh settings:

- PH: your Pharaoh CLI executable; discover on PATH or locate the built binary.
- PHARAOH_ROOT: optional source checkout containing the authoritative docs.
- PROJECT_DIR: actual project storage directory discovered from Pharaoh.
- SOURCE_DIR / OUTPUT_DIR: source files and delivery destination you choose.
- FFMPEG / FFPROBE: media executables used by your setup.
- SOFA: optional compatible HRTF dataset.

Do not literally copy angle-bracket placeholders from documentation as paths.
Quote paths in shell commands, especially when they contain spaces. A producer
or agent must supply actual project IDs, scene slugs and voice assignments.

## Start small

`assets/performance-pilot.fountain` is an original miniature scene for checking
whisper/shout delivery. Compile it into a test project, bind `NARRATOR` and `MIRA`
to voices you have permission to use, then review those two contrasting takes.
The bell is a deliberate isolated dramatic beat; keep the wind bed under speech.
This is an authoring example, not a pregenerated or universally validated render.

1. Load SKILL.md; read the source-to-performance contract before adaptation.
2. Confirm services and references. Create a short scene with a narrator and one
   actor, including one deliberately whispered or shouted line.
3. Generate and review one take. Verify both the actor and audible delivery.
4. Generate the scene, lay it out, restore supporting-effect overlaps, render.
5. Inspect metadata/loudness and listen before expanding to a full chapter.

A successful CLI result proves an operation ran, not that a performance is right.
Transcript checks cannot certify whispering, shouting, emotion or mix balance.

## Included references

- source-performance-contract.md: director context, explicit delivery, acoustic QA.
- production-notes.md: mix hierarchy, layout, ducking, revisions and video delivery.
- interior-voice-treatments.md: optional thought-voice processing and auditions.
- voice-timbre-repair.md: reference quality, provenance and stable casting.
- attribution-row-editing.md: narration attribution and compiled-row audits.
- cast-continuity.md: generic cast and continuity case study.
- sofalizer-build.md: portable FFmpeg capability and option checks.
- pharaoh-upstream-rebuild.md: safe version discovery and updates.

Run the optional probe from this folder:

```bash
python3 scripts/probe_sofalizer.py --json
python3 scripts/validate_bundle.py
```

The validator checks portable paths, local reference links and Python syntax.
It does not certify that every CLI or deployment platform works.

Use `--ffmpeg` to select the exact executable Pharaoh uses. The probe only checks
capabilities; it does not install anything or change a project.

## Scope and validation

The workflow was exercised on a configured Pharaoh setup, including retakes
with explicit delivery direction and looping-video delivery. Generalizing the
paths does not establish that every OS, GPU, backend or app version was tested.
Discover capabilities and run a pilot on the target machine. Numerical mix and
processing recipes are audition starting points, not universal standards.

Skill metadata declares MIT; Pharaoh and its model/data dependencies have their
own licences. No rights to any external voice, story or model are conveyed.
