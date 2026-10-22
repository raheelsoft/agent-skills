#!/usr/bin/env node
// run.mjs — the one entry for the plugin's Claude Code hooks (hooks/hooks.json): `node run.mjs <handler>` reads the event payload on stdin, hands it to
// handlers/<handler>.mjs and prints what that returns. A hook must never break a session by crashing, so every failure here is a note on stderr and
// an exit 0 — only a handler's own `block` or `deny` stops anything (reference/verification.md § Verification rules, Hooks).
//
//   handler:  export default (payload, ctx) => null | { decision: 'block', reason } | { hookSpecificOutput: … }
//   ctx:      { projectDir, claudeDir, pluginRoot } — projectDir is $CLAUDE_PROJECT_DIR (else the payload's cwd), claudeDir its .claude
//
// A handler decides from files, never from a model: its answer is the same for the same payload and the same project.
// No dependencies.

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The handler's answer to one payload, or null (let it through). Throws only for what the caller reports on stderr. */
export async function run(handler, raw, env = process.env) {
  if (!/^[a-z][a-z-]*$/.test(String(handler))) throw new Error(`no such handler "${handler}"`);
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return null; } // not a payload we know: nothing to decide
  const projectDir = resolve(env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  const ctx = { projectDir, claudeDir: join(projectDir, '.claude'), pluginRoot: resolve(HERE, '..') };
  const mod = await import(pathToFileURL(join(HERE, 'handlers', `${handler}.mjs`)).href);
  return (await mod.default(payload, ctx)) ?? null;
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const handler = process.argv[2];
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const out = await run(handler, raw);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(`tp hook ${handler}: ${String(e.message || e).split('\n')[0]} — let through\n`);
  }
  process.exit(0);
}
