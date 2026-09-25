#!/usr/bin/env node
// gates.mjs — the gate baseline and the gate record (skills/README.md § Verification rules). A `/tp-verify` result is a
// fact about two commits, so it is computed once and reused by every later stage that asks about the same commits;
// the base's whole-program output is computed once per base commit in one persistent baseline checkout per repo —
// never in a fresh checkout per call, never in the person's copy.
//
//   node gates.mjs base '{ repo, base, remote?, claudeDir }'
//        -> { checkout, sha, previous, moved, created, lockfilesChanged: [] }
//        ensures <.claude>/work/_scratch/wt/base-<repo-name> is a detached checkout of <remote>/<base>: created on first
//        use (git worktree add --detach), fetched and moved (git checkout --detach) when the base advanced, reset when a
//        run left it dirty; lockfilesChanged names the dependency lockfiles that differ from where it stood before (or
//        all it holds when just created) — install only then. Takes the repo's baseline lock: exit 3 while another
//        verify holds it (stale after tiers.json.gates.lockMinutes), exit 1 on a git failure.
//   node gates.mjs release '{ repo, claudeDir }'                 -> frees the baseline lock
//   node gates.mjs cache get '{ repo, sha, gate, command?, claudeDir }'
//        -> { file, command, at } for the base commit's cached normalised output (exit 0), exit 1 on a miss
//           (a different command for the same gate is a miss)
//   node gates.mjs cache put '{ repo, sha, gate, command?, file, claudeDir }'
//        -> stores <file>'s normalised form as _scratch/gates/<repo-name>/<sha>/<gate>.txt; prunes to tiers.json.gates.keepBases commits
//   node gates.mjs normalise '{ file, roots?: [] }'              -> the normalised lines: ANSI, positions (:12:5, (12,5)),
//                                                                    durations, stamps and the given roots stripped; sorted, unique
//   node gates.mjs new '{ repo, baseFile, headFile, checkout?, claudeDir }'
//        -> { new: [lines] } — the normalised lines in the head's output that are not in the base's ("no new errors vs
//           base"), both checkouts' paths stripped; exit 0 none, exit 1 some
//   node gates.mjs result get '{ repo, head, base, checkout?, claudeDir }'
//        -> the recorded result { repo, head, base, verdict, table, gates, at } (exit 0); exit 1 none recorded;
//           exit 2 <checkout> is not at <head> or has uncommitted changes (the record does not apply to it)
//   node gates.mjs result put '{ repo, head, base, verdict, table, gates?, checkout?, claudeDir }'
//        -> records it under _scratch/gates/<repo-name>/results/; exit 2 when <checkout> is dirty or elsewhere (nothing recorded)
//
// tiers.json.gates (defaults): { lockMinutes: 30, keepBases: 10, keepResults: 50 }
// No dependencies.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = { lockMinutes: 30, keepBases: 10, keepResults: 50 };
// the dependency lockfiles whose change means "install again" (README § Toolchain)
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'poetry.lock', 'Pipfile.lock', 'uv.lock', 'requirements.txt', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'mix.lock', 'Package.resolved'];
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const SHA = /^[0-9a-f]{7,64}$/;

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}
const writeJsonAtomic = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');

function config(claudeDir) {
  const t = readJson(join(claudeDir, 'tiers.json')) || {};
  const g = { ...DEFAULTS, ...(t.gates && typeof t.gates === 'object' ? t.gates : {}) };
  for (const k of Object.keys(DEFAULTS)) g[k] = Number(g[k]) > 0 ? Number(g[k]) : DEFAULTS[k];
  return g;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`}`);
  return (r.stdout || '').trim();
}

// where a repo's baseline and records live: <.claude>/work/_scratch/{wt/base-<name>, gates/<name>}
function places(input) {
  if (!input.repo || !input.claudeDir) throw new Error('repo and claudeDir are required');
  const repo = resolve(String(input.repo));
  const name = basename(repo);
  const scratch = join(resolve(String(input.claudeDir)), 'work', '_scratch');
  return { repo, name, checkout: join(scratch, 'wt', `base-${name}`), gates: join(scratch, 'gates', name) };
}

// ---- the baseline lock: one verify moves or runs the baseline at a time; a forgotten lock goes stale ----
function lockDir(p) { return join(p.gates, 'base.lock'); }
function takeLock(p, cfg) {
  const dir = lockDir(p);
  const stamp = join(dir, 'at');
  mkdirSync(p.gates, { recursive: true });
  try {
    mkdirSync(dir, { recursive: false }); // atomic: the first to create it holds it
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const at = isFile(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
    const ageMin = at ? (Date.now() - Date.parse(at)) / 60000 : Infinity;
    if (ageMin < cfg.lockMinutes) return { held: true, since: at };
    // stale: take it over
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(stamp, nowIso() + '\n');
  return { held: false };
}
export function release(input) {
  const p = places(input);
  rmSync(lockDir(p), { recursive: true, force: true });
  return { released: true };
}

// ---- the baseline checkout ----
export function base(input) {
  const p = places(input);
  const cfg = config(input.claudeDir);
  if (!input.base) throw new Error('base is required');
  const remote = input.remote || 'origin';
  const lock = takeLock(p, cfg);
  if (lock.held) return { error: 'held', since: lock.since, checkout: p.checkout, code: 3 };
  try {
    git(['fetch', '-q', remote, String(input.base)], p.repo);
    const sha = git(['rev-parse', `${remote}/${input.base}`], p.repo);
    let previous = null, moved = false, created = false;
    if (!isDir(join(p.checkout, '.git')) && !isFile(join(p.checkout, '.git'))) {
      if (isDir(p.checkout)) rmSync(p.checkout, { recursive: true, force: true }); // a leftover directory that is not a checkout
      mkdirSync(dirname(p.checkout), { recursive: true });
      git(['worktree', 'prune'], p.repo);
      git(['worktree', 'add', '-q', '--detach', p.checkout, sha], p.repo);
      created = true;
    } else {
      previous = git(['rev-parse', 'HEAD'], p.checkout);
      if (git(['status', '--porcelain'], p.checkout)) { // a run left it dirty: it is ours, nobody edits it
        git(['reset', '-q', '--hard'], p.checkout);
        git(['clean', '-fdq'], p.checkout);
      }
      if (previous !== sha) { git(['checkout', '-q', '--detach', sha], p.checkout); moved = true; }
    }
    // install again only when a lockfile differs from where the checkout stood before (all of them when just created)
    let lockfilesChanged = [];
    if (created) lockfilesChanged = git(['ls-tree', '--name-only', '-r', sha, '--', ...LOCKFILES], p.checkout).split('\n').filter(Boolean);
    else if (moved) lockfilesChanged = git(['diff', '--name-only', previous, sha, '--', ...LOCKFILES], p.checkout).split('\n').filter(Boolean);
    return { checkout: p.checkout, sha, previous, moved, created, lockfilesChanged };
  } catch (e) {
    release(input);
    throw e;
  }
}

// ---- normalising a gate's output so two runs compare as sets of findings ----
export function normaliseText(text, roots = []) {
  const rootRes = roots.filter(Boolean).map((r) => {
    let real = r;
    try { real = realpathSync(r); } catch { /* keep as given */ }
    return [r, real].filter((x, i, a) => a.indexOf(x) === i).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }).flat();
  const out = new Set();
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');                      // ANSI colour and cursor codes
    for (const r of rootRes) line = line.replace(new RegExp(r + '/?', 'g'), ''); // the checkouts' own paths
    line = line.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '')             // ISO stamps
      .replace(/^\s*\d+:\d+\s+/, '')                                        // a leading "line:col" (eslint's rows)
      .replace(/\(\d+,\d+\)/g, '')                                         // (line,col)
      .replace(/(\S):\d+(:\d+)?(?=$|[\s,;:)\]])/g, '$1')                    // path:line:col
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')                          // clock times
      .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins|minutes)\b/g, '') // durations
      .replace(/\s+/g, ' ').trim();
    if (line) out.add(line);
  }
  return [...out].sort();
}
export function normaliseFile(file, roots = []) {
  return normaliseText(readFileSync(resolve(file), 'utf8'), roots);
}

// ---- the base's cached outputs, per base commit ----
function cacheFile(p, sha, gate) {
  if (!SHA.test(String(sha))) throw new Error(`sha must be a commit hash, got ${JSON.stringify(sha)}`);
  const safe = String(gate).replace(/[^\w.-]+/g, '_');
  return { txt: join(p.gates, String(sha), `${safe}.txt`), meta: join(p.gates, String(sha), `${safe}.json`) };
}
export function cacheGet(input) {
  const p = places(input);
  if (!input.gate) throw new Error('gate is required');
  const f = cacheFile(p, input.sha, input.gate);
  if (!isFile(f.txt)) return null;
  const meta = readJson(f.meta) || {};
  if (input.command && meta.command && String(meta.command) !== String(input.command)) return null;
  return { file: f.txt, command: meta.command || null, at: meta.at || null };
}
export function cachePut(input) {
  const p = places(input);
  if (!input.gate || !input.file) throw new Error('gate and file are required');
  const f = cacheFile(p, input.sha, input.gate);
  const lines = normaliseFile(input.file, [p.checkout, ...(input.roots || [])]);
  writeAtomic(f.txt, lines.join('\n') + (lines.length ? '\n' : ''));
  writeJsonAtomic(f.meta, { gate: input.gate, command: input.command || null, sha: input.sha, at: nowIso(), lines: lines.length });
  prune(p, config(input.claudeDir));
  return { file: f.txt, lines: lines.length };
}
// keep the newest commits' outputs and the newest results; the rest is reproducible
function prune(p, cfg) {
  const shas = readdirSync(p.gates).filter((n) => SHA.test(n) && isDir(join(p.gates, n)))
    .map((n) => ({ n, t: statSync(join(p.gates, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const s of shas.slice(cfg.keepBases)) rmSync(join(p.gates, s.n), { recursive: true, force: true });
  const results = join(p.gates, 'results');
  if (isDir(results)) {
    const rs = readdirSync(results).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: statSync(join(results, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const r of rs.slice(cfg.keepResults)) rmSync(join(results, r.n), { force: true });
  }
}

// ---- "no new errors vs base": what the head's output says that the base's does not ----
export function newLines(input) {
  const p = places(input);
  if (!input.baseFile || !input.headFile) throw new Error('baseFile and headFile are required');
  const roots = [p.checkout, input.checkout].filter(Boolean);
  const baseSet = new Set(normaliseFile(input.baseFile, roots));
  return normaliseFile(input.headFile, roots).filter((l) => !baseSet.has(l));
}

// ---- the recorded results, per (head, base) ----
function resultFile(p, head, base) {
  if (!SHA.test(String(head)) || !SHA.test(String(base))) throw new Error('head and base must be commit hashes');
  return join(p.gates, 'results', `${head}.${base}.json`);
}
// does the record apply to this checkout: at that head, nothing uncommitted
function checkoutState(checkout, head) {
  try {
    const at = git(['rev-parse', 'HEAD'], checkout);
    if (at !== head && !at.startsWith(head) && !head.startsWith(at)) return `checkout is at ${at.slice(0, 12)}, not ${String(head).slice(0, 12)}`;
    const dirty = git(['status', '--porcelain'], checkout);
    if (dirty) return `checkout has uncommitted changes: ${dirty.split('\n').slice(0, 3).map((l) => l.trim()).join(', ')}`;
    return null;
  } catch (e) { return e.message; }
}
export function resultGet(input) {
  const p = places(input);
  const f = resultFile(p, input.head, input.base);
  const rec = readJson(f);
  if (!rec) return { code: 1 };
  if (input.checkout) {
    const why = checkoutState(resolve(String(input.checkout)), String(input.head));
    if (why) return { code: 2, error: why, record: rec };
  }
  return { code: 0, record: rec };
}
export function resultPut(input) {
  const p = places(input);
  if (!input.verdict || !input.table) throw new Error('verdict and table are required');
  if (input.checkout) {
    const why = checkoutState(resolve(String(input.checkout)), String(input.head));
    if (why) return { code: 2, error: why };
  }
  const rec = { repo: p.name, head: input.head, base: input.base, verdict: input.verdict, table: input.table, gates: input.gates || null, at: nowIso() };
  writeJsonAtomic(resultFile(p, input.head, input.base), rec);
  prune(p, config(input.claudeDir));
  return { code: 0, record: rec };
}

// ---- CLI ----
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (i) => { const raw = rest[i]; if (!raw) throw new Error('missing JSON argument'); return JSON.parse(raw); };
  const out = (obj) => console.log(JSON.stringify(obj, null, 2));
  try {
    if (cmd === 'base') { const r = base(arg(0)); if (r.error) { out({ error: r.error, since: r.since, checkout: r.checkout }); process.exit(r.code); } out(r); }
    else if (cmd === 'release') out(release(arg(0)));
    else if (cmd === 'cache' && rest[0] === 'get') { const r = cacheGet(arg(1)); if (!r) { out({ miss: true }); process.exit(1); } out(r); }
    else if (cmd === 'cache' && rest[0] === 'put') out(cachePut(arg(1)));
    else if (cmd === 'normalise' || cmd === 'normalize') { const i = arg(0); console.log(normaliseFile(i.file, i.roots || []).join('\n')); }
    else if (cmd === 'new') { const lines = newLines(arg(0)); out({ new: lines }); process.exit(lines.length ? 1 : 0); }
    else if (cmd === 'result' && rest[0] === 'get') { const r = resultGet(arg(1)); if (r.code === 0) out(r.record); else out({ error: r.code === 1 ? 'no result recorded for these commits' : r.error }); process.exit(r.code); }
    else if (cmd === 'result' && rest[0] === 'put') { const r = resultPut(arg(1)); if (r.code) { out({ error: r.error }); process.exit(r.code); } out(r.record); }
    else {
      console.error('usage: gates.mjs base|release|cache get|cache put|normalise|new|result get|result put <json>  (see the header)');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
