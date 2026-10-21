#!/usr/bin/env node
// worktree.mjs — a ticket's worktree, made, re-branched and removed by the script. /tp:start-ticket spent eight to twelve turns on this by hand: fetch, a branch name
// that collides with nobody's, `git worktree add`, the install into a log, the generated code, and the absolute paths of the ticket.json repo row; /tp:accept and
// the close-out another few on removing it without touching a sibling's. All of it is git and the project's own tools, so it runs here and returns the row.
//
//   node worktree.mjs add '{ repo, id, base, branch, claudeDir, remote?, from?, install? }'
//        fresh branch off <remote>/<base>, or — with `from` — off an open branch (a dependent ticket, or stacked on a sibling's PR: when a worktree of this repo
//        already holds `from`, that path is reused). A taken branch name gets -2, -3 … .  -> { status: "ok", row, reused?, install, codegen }
//                                                                         | { status: "blocked", why } (the branch is checked out in the person's own copy)
//                                                                         | { status: "error", error }            exit 0 ok, 1 blocked, 2 error
//   node worktree.mjs rebranch '{ worktree, base, branch, claudeDir, remote? }'   -> a new round: the same worktree on a new branch off the base
//   node worktree.mjs remove '{ repo, id, branch?, claudeDir, dry? }'              -> { removed, kept, plan } — never a worktree another ticket's ticket.json names
//   node worktree.mjs finish '{ workdir, dry? }'                                    -> the end of a ticket: `remove` for every repo row of its ticket.json, with the branch and base it records.
//        { status: "held", manualOpen } and nothing removed while acceptance left manual criteria to the person (`/tp:accept <id> answers=confirmed` ends the
//        hold; a failed step is a new round, which re-branches these checkouts) | { status: "ok", repos: [{ repo, removed, kept, plan }] }
// `row` is { name, path, worktree, branch, base } with absolute paths: what ticket.json's repos[] keeps. The install is the project's lockfile tool (tiers.json
// worktree.install overrides), its output in <.claude>/worktrees/_out/<id>/install-<repo>.log, read by exit code and tail; generated code follows codegen.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status as codegenStatus, mark as codegenMark } from './codegen.mjs';
import { computeState } from './state/compute.mjs';

// where node is, npm and npx are: the folder of the node running this script goes first on the PATH of the install and the code generation
const toolEnv = () => ({ ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` });
const INSTALL = [['package-lock.json', 'npm ci'], ['npm-shrinkwrap.json', 'npm ci'], ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'], ['yarn.lock', 'yarn install --frozen-lockfile'], ['bun.lock', 'bun install'], ['bun.lockb', 'bun install'],
  ['poetry.lock', 'poetry install'], ['Pipfile.lock', 'pipenv sync'], ['Gemfile.lock', 'bundle install'], ['composer.lock', 'composer install'], ['go.sum', 'go mod download']];
const sh = (cwd, cmd, args) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const git = (cwd, args) => sh(cwd, 'git', args);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const tailOf = (file, n = 5) => { try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };

/** The project's install command: tiers.json worktree.install, else the lockfile's tool; null when there is nothing to install. */
export function installCommand(dir, claudeDir) {
  const tiers = readJson(join(claudeDir, 'tiers.json')) || {};
  if (tiers.worktree && tiers.worktree.install !== undefined) return tiers.worktree.install || null;
  const hit = INSTALL.find(([f]) => existsSync(join(dir, f)));
  return hit ? hit[1] : null;
}

// A code generator that reads a setting it does not use (Prisma's `generate` wants DATABASE_URL, and the install runs it as a postinstall step) stops with
// "Cannot resolve environment variable: NAME". It connects to nothing, so one retry with a placeholder in that variable gets the same result the
// developer's own shell gets; the retry is reported, never silent.
const PLACEHOLDER = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
const missingEnv = (log) => { const m = /Cannot resolve environment variable:\s*([A-Z][A-Z0-9_]*)/.exec(tailOf(log, 60)); return m && !process.env[m[1]] ? m[1] : null; };

/** Runs `cmd` into `log`; a failure that names an unset variable is run once more with a placeholder in it. -> { exit, retry? } */
function runInto(cmd, dir, log) {
  const run = (extra) => spawnSync(`${cmd} > "${log}" 2>&1`, { cwd: dir, shell: true, env: { ...toolEnv(), ...extra } });
  let r = run({});
  const name = r.status !== 0 ? missingEnv(log) : null;
  if (!name) return { exit: r.status };
  r = run({ [name]: PLACEHOLDER });
  return { exit: r.status, retry: { env: name, why: `${name} was not set; the command only generates code, so it ran again with a placeholder value` } };
}

function prepare(dir, repoName, id, claudeDir, doInstall) {
  const out = { install: null, codegen: null };
  const cmd = doInstall === false ? null : installCommand(dir, claudeDir);
  if (cmd) {
    const outDir = join(claudeDir, 'worktrees', '_out', id); mkdirSync(outDir, { recursive: true });
    const log = join(outDir, `install-${repoName}.log`);
    const r = runInto(cmd, dir, log);
    out.install = { command: cmd, exit: r.exit, log, ...(r.retry ? { retry: r.retry } : {}), ...(r.exit === 0 ? {} : { tail: tailOf(log, 8) }) };
    if (r.exit !== 0) return { ...out, error: `install failed (${cmd}, exit ${r.exit}): ${tailOf(log, 3)}` };
  }
  const cg = codegenStatus({ repo: dir, claudeDir });
  if (cg.command && cg.stale) {
    const outDir = join(claudeDir, 'worktrees', '_out', id); mkdirSync(outDir, { recursive: true });
    const log = join(outDir, `codegen-${repoName}.log`);
    const r = runInto(cg.command, dir, log);
    out.codegen = { command: cg.command, exit: r.exit, ...(r.retry ? { retry: r.retry } : {}) };
    if (r.exit !== 0) return { ...out, error: `generating code failed (${cg.command}, exit ${r.exit}): ${tailOf(log, 3)}` };
    codegenMark({ repo: dir, claudeDir });
  }
  return out;
}

/** A branch name nobody has taken, locally or on the remote. */
function freeBranch(repo, remote, want) {
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? want : `${want}-${i}`;
    const local = git(repo, ['branch', '--list', name]).out;
    const far = git(repo, ['ls-remote', '--heads', remote, name]).out;
    if (!local && !far) return name;
  }
  return `${want}-${Date.now()}`;
}

export function add(input) {
  const repo = resolve(String(input?.repo || '')); const claudeDir = input?.claudeDir;
  if (!input?.repo || !input?.id || !input?.base || !input?.branch || !claudeDir) return { status: 'error', error: 'usage: worktree.mjs add \'{ "repo", "id", "base", "branch", "claudeDir", "remote"?, "from"?, "install"? }\'' };
  const remote = input.remote || 'origin'; const name = basename(repo);
  const worktree = join(resolve(claudeDir), 'worktrees', input.id, name);
  const src = input.from || input.base;
  const f = git(repo, ['fetch', remote, src]);
  if (!f.ok) return { status: 'error', error: `fetch of ${remote}/${src} failed: ${f.err.split('\n')[0]}` };
  let row; let reused = false;
  if (input.from && input.stack) { // stacked: reuse a worktree of this repo that already holds the branch
    const held = git(repo, ['worktree', 'list', '--porcelain']).out.split('\n\n').map((b) => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] })).find((w) => w.branch === input.from);
    if (held && held.path && realpathSync(held.path) !== realpathSync(repo)) { row = { name, path: repo, worktree: held.path, branch: input.from, base: input.base }; reused = true; }
  }
  if (!row) {
    mkdirSync(join(claudeDir, 'worktrees', input.id), { recursive: true });
    const branch = input.from && input.stack ? input.from : freeBranch(repo, remote, input.branch);
    const args = input.from && input.stack ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, `${remote}/${src}`];
    const w = git(repo, args);
    if (!w.ok) return /already (checked out|used by worktree)/.test(w.err) ? { status: 'blocked', why: `${branch} is checked out elsewhere (${w.err.split('\n')[0]}): move that copy off it, then run again` } : { status: 'error', error: `git worktree add failed: ${w.err.split('\n')[0]}` };
    row = { name, path: repo, worktree, branch, base: input.base };
  }
  const prep = reused ? { install: null, codegen: null } : prepare(row.worktree, name, input.id, claudeDir, input.install);
  if (prep.error) return { status: 'error', error: prep.error, row, install: prep.install, codegen: prep.codegen };
  return { status: 'ok', row, ...(reused ? { reused } : {}), install: prep.install, codegen: prep.codegen };
}

export function rebranch(input) {
  const wt = resolve(String(input?.worktree || '')); const claudeDir = input?.claudeDir;
  if (!input?.worktree || !input?.base || !input?.branch || !claudeDir || !existsSync(wt)) return { status: 'error', error: 'usage: worktree.mjs rebranch \'{ "worktree": <existing path>, "base", "branch", "claudeDir", "remote"? }\'' };
  const remote = input.remote || 'origin';
  const old = git(wt, ['rev-parse', 'HEAD']).out;
  const f = git(wt, ['fetch', remote, input.base]);
  if (!f.ok) return { status: 'error', error: `fetch of ${remote}/${input.base} failed: ${f.err.split('\n')[0]}` };
  const branch = freeBranch(wt, remote, input.branch);
  const c = git(wt, ['checkout', '-q', '-b', branch, `${remote}/${input.base}`]);
  if (!c.ok) return { status: 'error', error: `checkout failed: ${c.err.split('\n')[0]}` };
  const changed = git(wt, ['diff', '--name-only', old, `${remote}/${input.base}`]).out.split('\n');
  const lockChanged = INSTALL.some(([f2]) => changed.includes(f2));
  const id = basename(resolve(wt, '..'));
  const prep = prepare(wt, basename(wt), id, claudeDir, lockChanged ? undefined : false);
  return prep.error ? { status: 'error', error: prep.error, branch } : { status: 'ok', branch, installed: lockChanged, install: prep.install, codegen: prep.codegen };
}

export function remove(input) {
  const repo = resolve(String(input?.repo || '')); const claudeDir = input?.claudeDir;
  if (!input?.repo || !input?.id || !claudeDir) return { status: 'error', error: 'usage: worktree.mjs remove \'{ "repo", "id", "claudeDir", "branch"?, "dry"? }\'' };
  const remote = input.remote || 'origin'; const name = basename(repo);
  const worktree = join(resolve(claudeDir), 'worktrees', input.id, name);
  const work = join(claudeDir, 'work');
  const held = (existsSync(work) ? readdirSync(work) : []).filter((d) => d !== input.id && !d.startsWith('_'))
    .find((d) => ((readJson(join(work, d, 'ticket.json')) || {}).repos || []).some((r) => r && resolve(String(r.worktree || '')) === worktree));
  const plan = [];
  if (held) return { status: 'ok', removed: [], kept: [`${worktree} (ticket ${held} still names it)`], plan: [] };
  if (existsSync(worktree)) plan.push(`git -C ${repo} worktree remove --force ${worktree}`);
  const merged = input.branch ? git(repo, ['branch', '--merged', `${remote}/${input.base || 'main'}`]).out.split('\n').some((l) => l.replace(/^[*+ ]+/, '') === input.branch) : false;
  const pushed = input.branch ? !!git(repo, ['ls-remote', '--heads', remote, input.branch]).out : false;
  if (input.branch && (merged || !pushed)) plan.push(`git -C ${repo} branch -D ${input.branch}`);
  if (input.dry) return { status: 'ok', removed: [], kept: [], plan };
  const removed = []; const kept = [];
  if (existsSync(worktree)) { const r = git(repo, ['worktree', 'remove', '--force', worktree]); (r.ok ? removed : kept).push(r.ok ? worktree : `${worktree} (${r.err.split('\n')[0]})`); }
  if (input.branch && (merged || !pushed)) { const r = git(repo, ['branch', '-D', input.branch]); (r.ok ? removed : kept).push(r.ok ? `branch ${input.branch}` : `branch ${input.branch} (${r.err.split('\n')[0]})`); }
  else if (input.branch) kept.push(`branch ${input.branch} (pushed and not merged)`);
  try { rmdirSync(join(resolve(claudeDir), 'worktrees', input.id)); } catch { /* another repo's worktree is still in it */ }
  return { status: 'ok', removed, kept, plan };
}

/** The end of a ticket's worktrees, decided here and not by the model: every repo row's checkout and merged branch go — unless the person still has manual steps to do. */
export function finish(input) {
  const workdir = resolve(String(input?.workdir || ''));
  if (!input?.workdir) return { status: 'error', error: 'usage: worktree.mjs finish \'{ "workdir": "<.claude>/work/<id>", "dry"? }\'' };
  const ticket = readJson(join(workdir, 'ticket.json'));
  if (!ticket) return { status: 'error', error: `${join(workdir, 'ticket.json')} is missing or unreadable` };
  const manualOpen = computeState(workdir).manualOpen || 0;
  if (manualOpen) return { status: 'held', manualOpen, why: `${manualOpen} manual criteri${manualOpen === 1 ? 'on is' : 'a are'} open: the worktrees stay until the person confirms (/tp:accept ${ticket.id} answers=confirmed) or a failed step starts a new round` };
  const claudeDir = resolve(workdir, '..', '..');
  const repos = (ticket.repos || []).filter((r) => r && r.path && !r.discarded).map((r) => ({ repo: r.name || basename(r.path), ...remove({ repo: r.path, id: ticket.id, branch: r.branch, base: r.base, claudeDir, remote: input.remote, dry: input.dry }) }));
  return { status: 'ok', repos };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, arg] = process.argv;
  const fn = { add, rebranch, remove, finish }[cmd];
  let input; try { input = JSON.parse(arg || '{}'); } catch (e) { console.error(`the argument is not JSON: ${e.message}`); process.exit(2); }
  if (!fn) { console.error('usage: worktree.mjs add|rebranch|remove \'<json>\''); process.exit(2); }
  const r = fn(input);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.status === 'error' ? 2 : r.status === 'blocked' || r.status === 'held' ? 1 : 0);
}
