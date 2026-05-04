# AudioLDM Evaluation

## Decision
Integrate AudioLDM v1 as Pharaoh's long-form SFX/soundscape backend. Keep Woosh as the default for short foley and one-shot effects. Do not integrate AudioLDM2 as a production long-soundscape backend yet.

## Rationale
- AudioLDM v1 exposes duration control and upstream examples include long samples/soundscapes. Hugging Face diffusers also exposes `audio_length_in_s` for `AudioLDMPipeline`.
- AudioLDM2 has a newer architecture and larger text/audio stack, but the upstream README still lists support for generating longer audio over 10 seconds as TODO. That makes it a poor first target for minute-scale rain, wind, traffic, or room tone.
- Woosh quality remains better for short foley in Pharaoh's current workflow, but it should not be stretched into beds by stitching many short chunks.

## Pharaoh Mapping
- `woosh`: default backend, short foley, best under roughly 5 seconds.
- `audioldm`: explicit backend for long effects and ambience beds. Headless CLI routes `BED` rows and >5-second SFX rows here.
- `audioldm2`: defer until a checkpoint/workflow proves reliable for long, coherent ambience generation.

## Sources
- AudioLDM README: https://github.com/haoheliu/AudioLDM
- AudioLDM demo long samples: https://audioldm.github.io/
- AudioLDM diffusers docs: https://huggingface.co/docs/diffusers/main/api/pipelines/audioldm
- AudioLDM2 README: https://github.com/haoheliu/audioldm2
- AudioLDM2 diffusers docs: https://huggingface.co/docs/diffusers/main/api/pipelines/audioldm2
