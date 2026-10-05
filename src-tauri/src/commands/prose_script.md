# commands/prose_script.rs

Claude's half of prose → script, plus the Tauri commands.

- `prose_to_script_impl(args)`: parse the chapter (`prose::parse`), build the
  cast (project names + `discover_names`), take the heuristic plan, and — when
  the API key env var is set and `heuristic` is off — replace it with
  Claude's (`merge`: Claude's speaker per quote, snapped to cast spelling;
  quotes it skipped keep the heuristic guess; its scenes and cues). Then
  `prose::assemble`. Returns the Fountain, stats, new speaker names, tokens,
  and a `note` when Claude was asked for but no key was found.
- `claude_plan`: segments go in ~24k-character chunks (whole paragraphs),
  each with the last 14 segments and their speakers as context. One
  `POST /v1/messages` per chunk: `claude-opus-5-5`, adaptive thinking,
  effort high, structured output (`plan_schema`), `fallbacks: "default"`
  with the `server-side-fallback-2026-07-01` beta. A refusal or max_tokens
  stop is an error. Claude never returns prose — only ids, names, verbs,
  directions, headings and cue prompts.
- `#[tauri::command] prose_to_script(args)`, and `import_script_text(project_id,
  fountain, dry_run)`, which runs `cli::scene_script::import_fountain` (the
  body of `pharaoh script import`).

The key comes from `ANTHROPIC_API_KEY` or the project's
`llm_config.api_key_env`; it is never logged or returned.
