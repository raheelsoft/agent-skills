// session-start — SessionStart. Two things, only in a project that ran /tp:setup: a heartbeat (work/_heartbeat.json) that proves the plugin's
// hooks fire here — /tp:doctor warns when it is missing or old, because a hook that fails open is otherwise silent — and a short brief for the
// session when there is something to know: the open stops, and the runs that are live. Nothing to report, nothing printed.
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inbox } from '../../lib/state/inbox.mjs';
import { liveLocks } from '../../lib/state/lock.mjs';
import { tpProject, workRoot } from '../shared.mjs';

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const version = (ctx) => { try { return JSON.parse(readFileSync(join(ctx.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return null; } };

export function beat(payload, ctx) {
  const dir = workRoot(ctx);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '_heartbeat.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), source: payload.source || null, session: payload.session_id || null, plugin: version(ctx) }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function brief(ctx) {
  const root = workRoot(ctx);
  if (!existsSync(root)) return null;
  const lines = [];
  const stops = inbox(root);
  if (stops.length) {
    const shown = stops.slice(0, 3).map((s) => `${s.id}${s.stage ? ` ${s.stage}` : ''} — ${clip(s.question, 70)}`);
    lines.push(`tp: ${stops.length} open stop${stops.length === 1 ? '' : 's'}: ${shown.join('; ')}${stops.length > 3 ? `; +${stops.length - 3} more` : ''}`);
  }
  const live = liveLocks(root);
  if (live.length) lines.push(`tp: run live: ${live.slice(0, 3).map((l) => `${l.id} (${l.owner})`).join(', ')}${live.length > 3 ? `, +${live.length - 3} more` : ''}`);
  if (stops.length) lines.push('tp: /tp:inbox lists every stop with the document to read and the command that resumes it.');
  return lines.length ? lines.join('\n') : null;
}

export default function sessionStart(payload, ctx) {
  if (!tpProject(ctx)) return null;
  beat(payload, ctx);
  const text = brief(ctx);
  return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : null;
}
