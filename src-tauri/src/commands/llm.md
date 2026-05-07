# `llm.rs` — Anthropic LLM integration

## Intent

Generate or revise a Fountain-format scene draft from the project context.
Single-shot, non-streaming for now (max_tokens 4096). Streaming is a
follow-up.

## API key handling

The key is read from the env var named in `project.json → llm_config.api_key_env`
(default `ANTHROPIC_API_KEY`). The frontend never sees the key — only the
env-var name. If the variable is unset, the command returns a friendly error
that names the variable.

## Request shape

`draft_scene(args: DraftSceneArgs) -> DraftSceneResult`

`DraftSceneArgs` carries everything the model needs: project metadata
(title/logline/synopsis/tone), the cast (name + description + voice direction),
the scene info (title/description/location), and an optional `previous_fountain`
to revise rather than start from scratch.

## System prompt

Lives as `SYSTEM_PROMPT` in this file. It teaches the model the
audio-drama-flavored Fountain conventions (`SFX:` / `BED:` / `MUSIC:`) and
biases it toward dialogue-driven structure since we're writing for ears.

## What this is not

- Not a streaming endpoint — output is buffered and returned whole.
- Not multi-provider: only Anthropic for now. The `provider` field on
  `llm_config` is reserved for later OpenAI / local backends.
- Not a chat: each call is single-shot. Conversational context and rewrites
  are expressed by passing `previous_fountain`.
