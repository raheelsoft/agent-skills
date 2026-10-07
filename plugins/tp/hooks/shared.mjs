// shared.mjs — what more than one hook handler needs: is this a project the pipeline is set up in, is the call part of a run, does a path
// belong to the pipeline's work directory. Plain functions of the payload and the project; none decides anything on its own.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { liveLocks } from '../lib/state/lock.mjs';
import { artifactOf } from '../lib/contract/registry.mjs';

/** The path with its symlinks resolved as far as it exists (macOS's /tmp is /private/tmp): the part that is not there yet is kept as written. */
export function real(p) {
  const abs = resolve(p);
  const rest = [];
  for (let cur = abs; ; ) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}
export const within = (child, parent) => { const c = real(child); const p = real(parent); return c === p || c.startsWith(p + sep); };

/** A project that ran /tp:setup: it has the pipeline's configuration. A plugin that is merely enabled leaves such a project alone. */
export const tpProject = (ctx) => ['tiers.json', 'pipeline.json'].some((f) => existsSync(join(ctx.claudeDir, f)));
export const workRoot = (ctx) => join(ctx.claudeDir, 'work');

/** A copy of the pipeline's skills kept in the project's own .claude (the legacy install): its skills write the files by hand, so the write guards stand down. */
export function legacyCopy(ctx) {
  try { return readdirSync(join(ctx.claudeDir, 'skills')).some((n) => n.startsWith('tp-')); } catch { return false; }
}

/** Is this tool call part of a pipeline run: made by a sub-agent, made inside a ticket's work directory (its worktrees), or made while a run lock is live. */
export function inRun(payload, ctx) {
  if (payload.agent_id) return true;
  if (payload.cwd && existsSync(workRoot(ctx)) && within(payload.cwd, workRoot(ctx))) return true;
  return liveLocks(workRoot(ctx)).length > 0;
}

/** What a file in a ticket's work directory is written through, or null for a file anybody may write (plan.md, answers.md, checkpoints, reports …). */
export function writerOf(file) {
  const name = basename(file);
  const kind = artifactOf(name);
  if (kind) return { kind: 'put', artifact: name.replace(/\.json$/, ''), name };
  if (name === 'progress.md') return { kind: 'log', name };
  if (name === 'lock.json') return { kind: 'lock', name };
  return null;
}

/** The refusal for a write to `target` (a path as written in the command, or a tool's file_path), or null when it may go ahead. */
export function protectedReason(target, payload, ctx) {
  const writer = writerOf(target);
  if (!writer) return null;
  const literal = String(target);
  let inTicketDir;
  if (/\$/.test(literal)) inTicketDir = /\/work\/[^/$_][^/$]*\/[^/]+$/.test(literal); // a variable in the path: only its literal text can say
  else {
    const abs = literal.startsWith('/') ? literal : resolve(payload.cwd || ctx.projectDir, literal);
    const file = real(abs);
    const root = real(workRoot(ctx));
    const rel = file.startsWith(root + sep) ? file.slice(root.length + 1).split(sep) : null;
    inTicketDir = !!rel && rel.length === 2 && !rel[0].startsWith('_'); // a ticket's own file: not the work root's, not a _ folder's, not a repo file inside a worktree
  }
  if (!inTicketDir) return null;
  const lib = join(ctx.pluginRoot, 'lib');
  const wd = /\$/.test(literal) ? '<workdir>' : dirname(literal.startsWith('/') ? literal : resolve(payload.cwd || ctx.projectDir, literal)); // the directory this file is in: the one the command takes
  if (writer.kind === 'put') return `refused: ${writer.name} is written with \`node ${lib}/state.mjs put ${wd} ${writer.artifact} '<json>'\` (the JSON as an argument, with --from <file>, or on stdin), which checks it against its schema first (schemas/README.md); a raw write skips the check. To edit it by hand, use your own editor.`;
  if (writer.kind === 'log') return `refused: progress.md is appended with \`node ${lib}/state.mjs log ${wd} <stage> <started|done|stopped|note> "<summary>"\`; a raw write can break the grammar the state script reads.`;
  return `refused: lock.json is taken and released with \`node ${lib}/state.mjs lock|unlock ${wd} <owner>\`.`;
}

/** A PreToolUse answer. */
export const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
export const allow = (reason, extra = {}) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason, ...extra } });
