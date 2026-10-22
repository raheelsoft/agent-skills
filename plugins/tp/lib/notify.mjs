#!/usr/bin/env node
// notify.mjs — the deterministic half of /tp:notify's Send path: read <.claude>/notify.json, apply the level filter and the "no tool, no channel" cases,
// and build the one line to send. The model only loads the chat tool and posts what this returns, so a stop, a finished run and an error cost one short
// call, not a skill's whole text read to work out that nothing is configured or that the level is muted (skills/notify/SKILL.md).
//
//   node notify.mjs prepare <.claude> <level> "<text>"
//     -> { send: false, result: "notifications off" | "notifications: channel not set — /tp:notify setup target=<channel>" | "notifications: <level> muted" }
//      | { send: true, tool, target, message: "[<project>] <text>" }          exit 0 either way: nothing to send is not a failure
// `level` is stop|done|error|info (default info); `levels` in notify.json defaults to stop, done, error. The message is cut to one line of at most 300 characters.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LEVELS = ['stop', 'done', 'error'];
const MAX = 300;

/** The decision for one message — pure over the parsed config (null = no file). */
export function prepare(config, level, text) {
  if (!config || config.tool == null) return { send: false, result: 'notifications off' };
  if (config.target == null) return { send: false, result: 'notifications: channel not set — /tp:notify setup target=<channel>' };
  const lvl = ['stop', 'done', 'error', 'info'].includes(level) ? level : 'info';
  const levels = Array.isArray(config.levels) ? config.levels : DEFAULT_LEVELS;
  if (!levels.includes(lvl)) return { send: false, result: `notifications: ${lvl} muted` };
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  const body = one.length > MAX ? `${one.slice(0, MAX - 1)}…` : one;
  return { send: true, tool: config.tool, target: config.target, message: `[${config.project || 'project'}] ${body}` };
}

export function prepareFromDir(claudeDir, level, text) {
  let config = null;
  try { config = JSON.parse(readFileSync(join(claudeDir, 'notify.json'), 'utf8')); } catch { config = null; }
  return prepare(config, level, text);
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, claudeDir, level, ...text] = process.argv;
  if (cmd !== 'prepare' || !claudeDir || !text.length) { console.error('usage: notify.mjs prepare <.claude> <level> "<text>"'); process.exit(2); }
  console.log(JSON.stringify(prepareFromDir(claudeDir, level, text.join(' '))));
}
