# CastTab.tsx

## Purpose
The cast. Each member: name, library voice, description, want, flaw, engine, how they talk, catchphrases, signature bits (`lazzi` on disk), never, and how they treat each other member. All free text; no stock types.

## Design voice
With no voice linked, **Design voice →** saves a new character-library entry seeded from the sheet (name, description; base voice description from description + how they talk), links its `library_id`, and opens the Voices tab on it. With one linked, **Edit voice →** opens it there. A linked voice with no approved takes gets a nudge: episodes clone approved takes.

## Contracts
| Dependent | Expects |
|---|---|
| `character.rs` | `save_library_character` returns the entry with its `library_id` |
| `SeriesHomeView` | `onDesignVoice(libraryId)` switches to Voices on that entry |
