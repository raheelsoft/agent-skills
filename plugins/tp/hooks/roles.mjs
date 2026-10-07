// roles.mjs — what each of the plugin's role agents (agents/*.md) may do, held where a prompt cannot hold it: the bash and write hooks read the
// payload's agent_type. The verifiers are independent of whoever made the thing they check, so they read the repositories and change nothing in
// them; each writes only the one file its job produces. A tool list in the agent's definition takes tools away; this takes away what a tool the
// agent keeps could still do (a shell that rewrites a source file, a git that commits).
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gitOf, programOf, writeTargets } from './shell.mjs';
import { real, within, workRoot } from './shared.mjs';

/** What a role may write, as patterns on a path relative to the work root (`T-1/plan-check.json`, `_scratch/review-x.md`). */
export const ROLES = {
  'tp:plan-checker': { label: 'plan checker', writes: [/^[^/]+\/(plan-check\.json|checkpoint\.plan-check\.md)$/], says: 'plan-check.json (through state.mjs put) and its checkpoint', worktree: false },
  'tp:diff-validator': { label: 'diff validator', writes: [/^[^/]+\/(diff-validation\.md|checkpoint\.create-pr[\w.-]*\.md)$/], says: 'diff-validation.md and its checkpoint', worktree: false },
  'tp:researcher': { label: 'researcher', writes: [/^[^/]+\/(research\.json|checkpoint\.research\.md)$/], says: 'research.json (through state.mjs put) and its checkpoint', worktree: false },
  'tp:reviewer': { label: 'reviewer', writes: [/^_scratch\//], says: 'under work/_scratch/ (its review, its checkpoint, a checkout of its own)', worktree: true },
};

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'grep', 'merge-base', 'cat-file', 'describe', 'shortlog', 'name-rev', 'for-each-ref', 'show-ref', 'diff-tree', 'diff-index', 'range-diff', 'check-ignore', 'cherry', 'whatchanged', 'count-objects', 'fetch', 'version', 'help']);
const BRANCH_READ = new Set(['--show-current', '-a', '-r', '-l', '--list', '-v', '-vv', '--contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
const READ_CONFIG = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin']);
const PR_ACTING = new Set(['merge', 'close', 'edit', 'ready', 'reopen', 'review']);

/** Does this git command only read? (`worktree add/remove` counts for a role that keeps a checkout of its own.) */
function gitReads(g, role) {
  if (GIT_READ.has(g.sub)) return true;
  const [first] = g.args;
  switch (g.sub) {
    case 'branch': return g.args.every((a, i) => BRANCH_READ.has(a) || (!a.startsWith('-') && BRANCH_READ.has(g.args[i - 1])));
    case 'remote': return first === undefined || first === '-v' || first === 'show' || first === 'get-url';
    case 'config': return g.args.some((a) => READ_CONFIG.has(a));
    case 'stash': return first === 'list' || first === 'show';
    case 'tag': return g.args.length === 0 || g.args.every((a) => a === '-l' || a === '--list' || a.startsWith('--sort') || a.startsWith('--contains') || a.startsWith('--points-at'));
    case 'worktree': return first === 'list' || (role.worktree && ['add', 'remove', 'prune'].includes(first));
    default: return false;
  }
}

const tmpRoots = () => ['/tmp', '/private/tmp', real(tmpdir())];
const inTmp = (p) => tmpRoots().some((t) => within(p, t));
/** Is the file inside a git checkout (a `.git` in a folder above it)? A scratch file the role writes is never one of those. */
function inCheckout(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Is the role allowed to write this path: a file of its own job inside the work directory, or a temporary file outside every checkout. */
function mayWrite(role, target, payload, ctx) {
  const literal = String(target);
  if (literal.startsWith('/dev/')) return true;
  if (/\$/.test(literal)) return false; // a path the hook cannot read is not one it can vouch for
  const file = real(literal.startsWith('/') ? literal : resolve(payload.cwd || ctx.projectDir, literal));
  const root = real(workRoot(ctx));
  if (file.startsWith(root + sep)) return role.writes.some((re) => re.test(relative(root, file).split(sep).join('/'))); // the work directory: only the role's own files
  return inTmp(file) && !inCheckout(file);
}

/** Why a Bash command is refused to this role, or null. `commands` is parseShell's output. */
export function roleBashReason(role, commands, payload, ctx) {
  for (const c of commands) {
    const g = gitOf(c);
    if (g && !gitReads(g, role)) return `refused: the ${role.label} reads the repositories and changes nothing in them — \`git ${g.sub}\` does. Say what you need changed in your report.`;
    const p = programOf(c);
    if (p && p.name === 'gh' && p.args[0] === 'pr' && PR_ACTING.has(p.args[1])) return `refused: the ${role.label} reports, it does not act on a pull request (\`gh pr ${p.args[1]}\`): merging, closing and approving are the author's side's call.`;
    for (const target of writeTargets(c, { removals: true })) {
      if (!mayWrite(role, target, payload, ctx)) return `refused: the ${role.label} writes only ${role.says} — not ${target}.`;
    }
  }
  return null;
}

/** Why a Write, Edit or MultiEdit on `file` is refused to this role, or null. */
export function roleWriteReason(role, file, payload, ctx) {
  return mayWrite(role, file, payload, ctx) ? null : `refused: the ${role.label} writes only ${role.says} — not ${file}.`;
}
