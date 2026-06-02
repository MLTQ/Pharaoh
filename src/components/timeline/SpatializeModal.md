# SpatializeModal.tsx

## Intent

The one place a user (or a future agent surface) sets spatial placement
*and* a room space on a single timeline clip. Reads/writes five columns on
`ScriptRow`: `spatial_azimuth`, `spatial_elevation`, `spatial_path`,
`spatial_space`, and `reverb_send`. The render path in
`src-tauri/src/commands/audio_spatial.rs` is the canonical consumer.

## Two orthogonal axes

The modal exposes binaural placement (the dial + waypoint list) and a
*Space* picker as separate concerns. A clip can be placed at az=90° with
no room, or sit at the front in a cathedral, or both. The Save logic only
persists each axis when it differs from the defaults — empty
`spatial_space` means dry, empty `reverb_send` means "use the manifest's
default_wet for the chosen space."

## Behavior

- Two modes — Static and Trajectory — switched via the top toggle.
  Switching modes never destroys the other mode's data; only the Save
  decides what gets persisted. Save in Static mode clears `spatial_path`;
  Save in Trajectory mode preserves both static + waypoints (waypoints
  drive rendering; static is the fallback when waypoints are empty).
- The azimuth dial is a top-down ring with the listener at the center and
  the source as a draggable dot. F/R/B/L cardinals are rendered as ticks.
- The elevation slider is vertical; +90° = above, -90° = below.
- Trajectory mode shows a waypoint list. Each row has a t_frac slider, an
  azimuth NumberSpin, an elevation NumberSpin, and a remove button. Click
  a row to *select* it — while selected, the big dial controls that
  waypoint instead of the static fallback. This is the discoverable way to
  edit a waypoint visually.

## Web Audio preview

Preview uses the browser's `PannerNode` with `panningModel="HRTF"`. This
is not bit-identical to the ffmpeg `sofalizer` render (different HRTF
data; different HRIR convolution; different distance model) but it gives
an *instant* binaural impression while dialing the dial. The accurate
preview is the actual scene render.

Coordinate convention: Web Audio's listener faces -z, so we map azimuth/
elevation → (x, y, z) accordingly. Distance is fixed at 1.5 m to keep
the rolloff comfortable on headphones. See `sphericalToCartesian()`.

For trajectory preview the panner's position uses
`linearRampToValueAtTime` between scheduled waypoints — same shape as the
ffmpeg segmented render, just continuous rather than chunked.

## Save shape

- Azimuth and elevation are stringified one-decimal degrees: `"90.0"`.
- Path is JSON `[{t_frac, az, el}, ...]`, sorted by t_frac, with az
  wrapped to `[0, 360)` and el clamped to `[-90, 90]`. Empty string when
  in Static mode or trajectory mode without any waypoints.
- Space is the catalog slug, with `"anechoic"` collapsed to `""` so the
  CSV doesn't carry a no-op default.
- ReverbSend (wet amount) is only persisted when the user dragged the
  slider — otherwise it stays `""` and the renderer applies the manifest
  default. The slider shows the effective value in either case.

## Clear spatial

The "Clear spatial" footer button writes `("", "", "")` and closes the
modal. The render path treats those as "no spatial data" and reverts to
the legacy equal-power `pan` filter.

## Known limitations

- The elevation slider uses both `writing-mode: vertical-lr` and the
  legacy `-webkit-appearance: slider-vertical`. Webkit support for
  vertical sliders is uneven; the experience may look ordinary in some
  browsers but the interaction is still correct.
- No drag-and-drop reordering of waypoints — they sort by t_frac
  automatically on every edit, which is the closest thing to reorder.
- Preview uses the *raw* source file, not the post-rendered scene
  (where this clip gets ducking + bus EQ etc). It's intended as a
  positioning aid, not a final mix preview.
