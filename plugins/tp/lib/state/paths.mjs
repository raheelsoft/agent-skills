// paths.mjs — where the pipeline puts what an agent writes with its own tools. The runtime asks a person before a file tool, a shell redirect or
// a `mkdir` touches anything under a project's `.claude/` — and, with nobody there, refuses — except under `.claude/worktrees/`, which it keeps
// for git worktrees. So the work directory (`<.claude>/work/`) is written only by the state script, and the two things an agent does write
// live in the exempt folder: a ticket's checkouts and the output of the commands it runs.
//
//   <.claude>/worktrees/<id>/<repo-name>/    a ticket's one worktree per repo, from pickup to the end of the run
//   <.claude>/worktrees/_out/<id>/           a ticket's command output and drafts (`<command> > <file> 2>&1`); one folder per ticket, so two running side by side share no name
//
// A ticket picked up before this layout keeps its worktree at `<.claude>/work/<id>/wt/<repo-name>`: ticket.json records the absolute path, so
// every stage still finds it, and the listing below reads both.
import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDir } from './util.mjs';

export const WORKTREES = 'worktrees';
export const OUT = '_out';

/** `<.claude>` of a ticket's work directory (`<.claude>/work/<id>`). */
export const claudeOf = (workdir) => resolve(workdir, '..', '..');
/** Where the pipeline's agents may write: the checkouts and the output folder. */
export const worktreesRoot = (claudeDir) => join(claudeDir, WORKTREES);
/** Where a ticket's worktrees go: one folder per repo inside it. */
export const ticketWorktrees = (claudeDir, id) => join(worktreesRoot(claudeDir), id);
/** Where an agent sends the output of a command that could exceed a screen, and its drafts. */
export const outDir = (claudeDir) => join(worktreesRoot(claudeDir), OUT);
/** The same, for one ticket: a folder of its own. */
export const ticketOut = (claudeDir, id) => join(outDir(claudeDir), id);

const subdirs = (dir) => (isDir(dir) ? readdirSync(dir).filter((n) => isDir(join(dir, n))) : []);

/** The names of the worktrees a ticket holds on disk: its folder under `worktrees/`, and the `wt/` folder an earlier pickup made in its work directory. */
export function worktreesOnDisk(workdir) {
  const id = basename(resolve(workdir));
  return [...new Set([...subdirs(ticketWorktrees(claudeOf(workdir), id)), ...subdirs(join(workdir, 'wt'))])].sort();
}

const TICKET_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The project's `<.claude>`: CLAUDE_PROJECT_DIR's, else the nearest `.claude` above the working directory (a ticket's worktree sits inside it). */
function projectClaude(env, cwd) {
  if (env.CLAUDE_PROJECT_DIR && isDir(join(env.CLAUDE_PROJECT_DIR, '.claude'))) return join(env.CLAUDE_PROJECT_DIR, '.claude');
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (isDir(join(dir, '.claude', 'work'))) return join(dir, '.claude');
    if (dirname(dir) === dir) return null;
  }
}

/** A ticket's work directory from what an agent typed: a path stays as it is; a bare ticket id (`PIK-12`) that is no folder here becomes `<.claude>/work/<id>`. */
export function resolveWorkdir(arg, { env = process.env, cwd = process.cwd() } = {}) {
  if (typeof arg !== 'string' || !TICKET_ID.test(arg) || isDir(arg)) return arg;
  const claude = projectClaude(env, cwd);
  return claude ? join(claude, 'work', arg) : arg;
}
