# EpisodesTab.tsx

## Purpose
The writers' room. A premise (typed, picked from three pitches, or empty to leave it to the writer) goes straight to **Write episode**, or through **Beat sheet first**: an editable plan (title, logline, per-scene summary and beats, cut scenes) that is then written. "Writers' room pass" toggles the punch-up. **Start a blank episode** makes an empty linked project to write by hand.

## Behaviour
- Writing runs in `seriesStore.startWrite`, so it survives tab and view changes; the card shows the current stage and elapsed time, and a toast offers **Open →** when it lands.
- The hint under the form names cast members without a voice (they join each episode as blank characters with a voice description to design).

## Contracts
| Dependent | Expects |
|---|---|
| `episode_writer.rs` | `pitch_episodes`, `plan_episode`, `write_episode` |
| `SeriesHomeView` | `onOpen`, `beforeCreate` (flush the bible), `onGoTo(tab)` |
