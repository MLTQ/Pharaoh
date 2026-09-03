#!/usr/bin/env node
/**
 * Verify every command name the frontend invokes actually exists in the Rust
 * command handler.
 *
 * The Tauri IPC boundary is stringly typed: `invoke("get_corpus_job_status")`
 * compiles whether or not that command was ever written. Five commands behind
 * the Corpus and Model tabs were missing for months because the components
 * caught the resulting errors and rendered an empty state.
 *
 * Usage: node scripts/check-invoke-commands.mjs
 * Exits non-zero and lists the offenders when a name has no Rust counterpart.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── The registered surface: names inside generate_handler![...] ──────────────
const libRs = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
const handlerStart = libRs.indexOf("generate_handler!");
if (handlerStart === -1) {
  console.error("could not find generate_handler! in src-tauri/src/lib.rs");
  process.exit(2);
}
// Take the bracketed list that follows.
const open = libRs.indexOf("[", handlerStart);
let depth = 0;
let close = open;
for (let i = open; i < libRs.length; i++) {
  if (libRs[i] === "[") depth++;
  else if (libRs[i] === "]") {
    depth--;
    if (depth === 0) {
      close = i;
      break;
    }
  }
}
const registered = new Set(
  libRs
    .slice(open + 1, close)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((path) => path.split("::").pop()),
);

// ── The demanded surface: string literals passed to invoke() ─────────────────
const INVOKE_RE = /\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-z0-9_]+)["'`]/gi;
const demanded = new Map(); // command -> [files]

for (const file of walk(join(ROOT, "src"))) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(INVOKE_RE)) {
    const rel = file.slice(ROOT.length + 1);
    // The wrapper module and the transport shim define invoke; skip their own
    // internal plumbing but still check the names they forward.
    if (!demanded.has(m[1])) demanded.set(m[1], []);
    if (!demanded.get(m[1]).includes(rel)) demanded.get(m[1]).push(rel);
  }
}

const missing = [...demanded.entries()].filter(([cmd]) => !registered.has(cmd));

if (missing.length > 0) {
  console.error("Frontend invokes commands that are not registered in Rust:\n");
  for (const [cmd, files] of missing.sort()) {
    console.error(`  ${cmd}`);
    for (const f of files) console.error(`      ${f}`);
  }
  console.error(
    `\n${missing.length} missing of ${demanded.size} invoked; ` +
      `${registered.size} registered in generate_handler!.`,
  );
  process.exit(1);
}

console.log(
  `ok — ${demanded.size} invoked command names all present among ` +
    `${registered.size} registered in generate_handler!.`,
);
