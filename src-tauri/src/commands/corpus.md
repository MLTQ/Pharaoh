# commands/corpus.rs

## Purpose

Stage 3 of the character voice pipeline: turn a handful of approved palette
reference takes into minutes of varied audio that RVC training (stage 4) can
consume.

The GUI's Corpus tab has driven four commands since it shipped, but none of them
existed in Rust — `CorpusBuilder` swallowed the resulting errors, so "Generate
corpus" and "Clear" silently did nothing and the per-emotion breakdown was always
empty. This module is the missing half.

## Components

### `get_corpus_emotion_counts`
- **Does**: Counts `.wav` files in `characters/{id}/rvc_corpus/`, grouped by the
  emotion encoded in the filename stem. Sorted, so the UI list is stable across
  polls.
- **Interacts with**: `CorpusBuilder`'s per-emotion breakdown.

### `clear_corpus`
- **Does**: Deletes every `.wav` and `.wav.meta.json` in the corpus directory,
  returning the number removed. Leaves the directory and any other file alone.

### `build_corpus`
- **Does**: For each approved palette entry, generates `target_count / n` takes
  by cloning that entry's reference WAV through Chatterbox, rotating through
  `CORPUS_LINES` and `TAG_VARIANTS`. Returns a job id and the total immediately;
  the work runs on a spawned task.
- **Interacts with**: the Chatterbox server's `/generate/clone` and `/jobs/{id}`.
- **Rationale**: takes are generated serially. The Chatterbox server holds one
  model and `torch.manual_seed` is global, so a parallel fan-out would thrash
  the GPU and let seeds cross-contaminate between takes.

### `get_corpus_job_status`
- **Does**: Returns `{completed, total, done, error}` for a build.
- **Rationale**: a build is one logical unit of work with a progress fraction,
  not N independent takes, so it is tracked in a module-local registry rather
  than the shared job store the queue UI reads.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `CorpusBuilder.tsx` | `build_corpus` returns `{job_id, total}` | Renaming either field |
| `CorpusBuilder.tsx` | `get_corpus_job_status` sets `done` exactly once at the end | Leaving `done` false after failure |
| `get_corpus_emotion_counts` | Files are named `{emotion}_{NNN}.wav` | Changing the naming scheme without updating `emotion_of` |
| MCP `build_corpus` | Same corpus directory and filename layout | Diverging layouts would split one character's corpus in two |

## Notes

- Requires at least one palette entry with `qa_status == "approved"` and a
  reference path. An unapproved take bakes its flaws into all fifty derived
  takes, which is why the filter is not configurable.
- Corpus lines are deliberately fixed sentences, not the character's
  `instruct_default` — that field is a voice *description*, not speech.
- Files whose stem has no numeric suffix are counted under `imported`; bulk
  imports keep their original filenames.
- Job entries are kept for the life of the process. They are tiny, and the UI
  polls a job by id once more after it finishes to read the final count.
