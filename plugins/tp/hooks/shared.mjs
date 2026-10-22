// shared.mjs — what more than one hook handler needs: is this a project the pipeline is set up in, is the call part of a run, does a path
// belong to the pipeline's work directory. Plain functions of the payload and the project; none decides anything on its own.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { liveLocks } from '../lib/state/lock.mjs';
import { artifactOf } from '../lib/contract/registry.mjs';
import { outDir, worktreesRoot } from '../lib/state/paths.mjs';

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

/** Is `dir` inside a ticket's worktree (`<.claude>/worktrees/<id>/…`, with a work directory for `<id>`) — not the runtime's own worktree of a person's, which sits in the same folder. */
function inTicketWorktree(dir, ctx) {
  const root = real(worktreesRoot(ctx.claudeDir));
  const abs = real(dir);
  if (!abs.startsWith(root + sep)) return false;
  const id = abs.slice(root.length + 1).split(sep)[0];
  return !id.startsWith('_') && existsSync(join(workRoot(ctx), id));
}

/** Is this tool call part of a pipeline run: made by a sub-agent, made inside the work directory or a ticket's worktree, or made while a run lock is live. */
export function inRun(payload, ctx) {
  if (payload.agent_id) return true;
  if (payload.cwd && existsSync(workRoot(ctx)) && within(payload.cwd, workRoot(ctx))) return true;
  if (payload.cwd && inTicketWorktree(payload.cwd, ctx)) return true;
  return liveLocks(workRoot(ctx)).length > 0;
}

// The work directory is the pipeline's record and the runtime keeps `<.claude>/` from an agent's own tools when nobody is there to approve it
// (lib/state/paths.mjs), so every file in it is written by a script: the stage JSON by `put`, progress.md by `log`, the lock by `lock`, any other
// document by `doc`. What an agent writes itself goes under `<.claude>/worktrees/`.
const SCRATCH = new Set(['_scratch', '_day']);
const DOCUMENT = /\.(md|txt)$/;

/** Where a path sits below the work root, as segments; null for a path outside it or a checkout kept inside it (`<id>/wt/…`, `_scratch/wt/…`). */
function workSegments(literal, payload, ctx) {
  let segs = null;
  if (/\$/.test(literal)) { // a variable in the path: only its literal text can say
    const m = /\/work\/((?:[^/$]+\/)*[^/$]+)$/.exec(literal);
    segs = m ? m[1].split('/') : null;
  } else {
    const file = real(literal.startsWith('/') ? literal : resolve(payload.cwd || ctx.projectDir, literal));
    const root = real(workRoot(ctx));
    segs = file.startsWith(root + sep) ? file.slice(root.length + 1).split(sep) : null;
  }
  return segs && segs[1] !== 'wt' ? segs : null;
}

/** What writes the file at `segs` (below the work root): put, log, lock, doc — or, for a file that is not a document, the output folder; else a script. */
export function writerOf(segs) {
  const name = segs[segs.length - 1];
  if (segs.length === 2 && !segs[0].startsWith('_')) { // a ticket's own file
    if (artifactOf(name)) return { kind: 'put', artifact: name.replace(/\.json$/, ''), name };
    if (name === 'progress.md') return { kind: 'log', name };
    if (name === 'lock.json') return { kind: 'lock', name };
    return DOCUMENT.test(name) ? { kind: 'doc', name } : name.endsWith('.json') ? { kind: 'script', name } : { kind: 'out', name };
  }
  if (segs.length === 2 && SCRATCH.has(segs[0])) return DOCUMENT.test(name) || name.endsWith('.json') ? { kind: 'doc', name } : { kind: 'out', name };
  return { kind: 'script', name };
}

/** The refusal for a write to `target` (a path as written in the command, or a tool's file_path), or null when it may go ahead. */
export function protectedReason(target, payload, ctx) {
  const literal = String(target);
  const segs = workSegments(literal, payload, ctx);
  if (!segs) return null;
  const writer = writerOf(segs);
  const lib = join(ctx.pluginRoot, 'lib');
  const folder = `${outDir(ctx.claudeDir)}/${segs[0].startsWith('_') ? '' : `${segs[0]}/`}`; // where this file's drafts and output go: its ticket's folder in the output folder, or the output folder itself
  const wd = /\$/.test(literal) ? '<workdir>' : dirname(literal.startsWith('/') ? literal : resolve(payload.cwd || ctx.projectDir, literal)); // the directory this file is in: the one the command takes
  switch (writer.kind) {
    case 'put': return `refused: ${writer.name} is written with \`node ${lib}/state.mjs put ${wd} ${writer.artifact} '<json>'\` (the JSON as an argument, with --from <file>, or on stdin), which checks it against its schema first (schemas/README.md); a raw write skips the check. To edit it by hand, use your own editor.`;
    case 'log': return `refused: progress.md is appended with \`node ${lib}/state.mjs log ${wd} <stage> <started|done|stopped|note> "<summary>"\`; a raw write can break the grammar the state script reads.`;
    case 'lock': return `refused: lock.json is taken and released with \`node ${lib}/state.mjs lock|unlock ${wd} <owner>\`.`;
    case 'doc': return `refused: ${writer.name} is written with \`node ${lib}/state.mjs doc ${wd} ${writer.name}\` — the text on stdin, or \`--from <file>\` (\`--append\` adds to the end of what is there). The runtime does not let an agent write under .claude/ itself: draw a long document up in ${folder} and place it with --from.`;
    case 'out': return `refused: ${writer.name} is a command's output, and the work directory takes documents only — send the output to ${folder} (\`<command> > ${folder}${writer.name} 2>&1\`), where an agent may write.`;
    default: return `refused: ${writer.name} is part of the work directory's record, written by the pipeline's scripts alone.`;
  }
}

/** A PreToolUse answer. */
export const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
export const allow = (reason, extra = {}) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason, ...extra } });
