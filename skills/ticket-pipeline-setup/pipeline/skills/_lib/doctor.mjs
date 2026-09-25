#!/usr/bin/env node
// doctor.mjs — the preflight (skills/README.md § Using it, Preflight): is this install able to run a ticket right now?
// Every check is a fact a run would otherwise discover mid-stage as an *environment* failure (§ Failures and
// escalation): the toolchain, the repos and their remotes, the platform CLI's auth, the pipeline's own files, the
// runtime's allowlist, leftovers in the work directory. Nothing here changes anything — it reports, with a fix per line.
//
//   node doctor.mjs run <.claude> [--repos <path,path>] [--tests] -> { at, ok, node, claudeDir, checks: [{ name, status, detail, fix }] }
//                                                                    written to <.claude>/work/_doctor.json; exit 0 clean, 1 warnings, 2 failures
//   node doctor.mjs fresh <.claude>                               -> { fresh, ok, ageHours, at }; exit 0 fresh and clean, 1 missing or older
//                                                                    than tiers.json.doctor.maxAgeHours, 2 failing
//   node doctor.mjs add <.claude> '{ "name", "status", "detail", "fix" }' -> add or replace one check (the skill's own tool-based check)
//
// tiers.json.doctor (defaults): { maxAgeHours: 24, timeoutMs: 8000,
//                                 checks: [{ name, run: [argv…], expect?: "<substring>" }] }   ← e.g. the hosting CLI's auth status
// Repos: --repos, else the paths every work directory's ticket.json names, else the git checkouts at or one level under
// the folder that holds <.claude>. Remote reachability is `git ls-remote` with prompts disabled, so a missing key or
// an expired credential fails here, in seconds, instead of inside a run (§ Remote access failures).
// No dependencies.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status as skillsStatus } from './setup.mjs';
import { cover as hookCover } from './hooks.mjs';
import { status as codegenStatus } from './codegen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { maxAgeHours: 24, timeoutMs: 8000, checks: [] };
const RATINGS = ['low', 'medium', 'high'];
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// A path ticket.json recorded, as an absolute one — the reading state.mjs's worktree check uses. Every path a
// skill writes is absolute (README § Definitions, `<.claude>`); a record from an earlier pickup can hold a
// relative one, and resolving that against this script's cwd loses the repo the ticket named — its remote and
// its recorded base go unchecked. The bases are the roots such a path was written against: the project folder
// around `<.claude>`, the `<.claude>` itself, the work directory; nothing exists → the project folder's reading.
function recordedPath(p, workdir) {
  if (!p || isAbsolute(p)) return p;
  const claudeDir = resolve(workdir, '..', '..'); // <.claude>/work/<id> -> <.claude>
  const bases = [dirname(claudeDir), claudeDir, workdir];
  return bases.map((b) => resolve(b, p)).find(isDir) || resolve(bases[0], p);
}

function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

function config(claudeDir) {
  const t = readJson(join(claudeDir, 'tiers.json')) || {};
  const d = { ...DEFAULTS, ...(t.doctor && typeof t.doctor === 'object' ? t.doctor : {}) };
  d.maxAgeHours = Number(d.maxAgeHours) > 0 ? Number(d.maxAgeHours) : DEFAULTS.maxAgeHours;
  d.timeoutMs = Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : DEFAULTS.timeoutMs;
  d.checks = Array.isArray(d.checks) ? d.checks.filter((c) => c && typeof c.name === 'string' && Array.isArray(c.run) && c.run.length) : [];
  return { tiers: t, doctor: d };
}

function cmd(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: opts.timeoutMs || DEFAULTS.timeoutMs, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes', ...(opts.env || {}) } });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? (timedOut ? `timed out after ${opts.timeoutMs || DEFAULTS.timeoutMs} ms` : r.error.message) : null };
}
const firstLine = (s) => String(s || '').trim().split('\n')[0] || '';

// the repos a run would touch: --repos, else the paths tickets recorded, else the checkouts around <.claude>
function repoPaths(claudeDir, given) {
  if (given) return String(given).split(',').map((p) => resolve(p.trim())).filter(Boolean);
  const work = join(claudeDir, 'work');
  const fromTickets = new Map();
  if (isDir(work)) for (const n of readdirSync(work)) {
    if (n.startsWith('_')) continue;
    const workdir = join(work, n);
    const t = readJson(join(workdir, 'ticket.json'));
    for (const r of t?.repos || []) {
      const p = r?.path && recordedPath(r.path, workdir);
      if (p && isDir(p)) fromTickets.set(resolve(p), r.base || fromTickets.get(resolve(p)) || null);
    }
  }
  if (fromTickets.size) return [...fromTickets.keys()];
  const home = dirname(resolve(claudeDir));
  const found = [];
  if (isDir(join(home, '.git'))) found.push(home);
  for (const n of readdirSync(home)) { const p = join(home, n); if (!n.startsWith('.') && isDir(p) && isDir(join(p, '.git'))) found.push(p); }
  return found;
}
function baseOf(claudeDir, repoPath, timeoutMs = DEFAULTS.timeoutMs) {
  const work = join(claudeDir, 'work');
  if (isDir(work)) for (const n of readdirSync(work)) {
    if (n.startsWith('_')) continue;
    const workdir = join(work, n);
    const t = readJson(join(workdir, 'ticket.json'));
    const row = (t?.repos || []).find((r) => r?.path && resolve(recordedPath(r.path, workdir)) === resolve(repoPath) && r.base);
    if (row) return row.base;
  }
  const head = cmd(['git', '-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0) return head.stdout.trim().replace(/^origin\//, '');
  const sym = cmd(['git', '-C', repoPath, 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs }); // the remote's own default branch
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(sym.stdout || '');
  if (m) return m[1];
  const cur = cmd(['git', '-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']); // last resort: the checkout's own branch
  return cur.code === 0 && cur.stdout.trim() && cur.stdout.trim() !== 'HEAD' ? cur.stdout.trim() : null;
}

// the allow rules the Install step asks for, with <.claude> substituted; a broader rule (a shorter prefix ending in *) covers one
function expectedRules(claudeDir) {
  return [`Bash(node ${claudeDir}/skills/_lib/*)`, `Bash(node ${claudeDir}/office/*)`, 'Bash(node --test *)',
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git fetch*)', 'Bash(git rev-parse*)', 'Bash(git merge-base*)',
    'Bash(git branch*)', 'Bash(git worktree *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git merge *)', 'Bash(git push *)'];
}
function covered(rule, allow) {
  const prefix = rule.replace(/\*\)$/, '').replace(/\)$/, '');
  return allow.some((a) => { const p = String(a).replace(/\*\)$/, '').replace(/\)$/, ''); return a === rule || (String(a).endsWith('*)') && prefix.startsWith(p)); });
}

export function run(claudeDir, opts = {}) {
  claudeDir = resolve(claudeDir);
  if (!isDir(join(claudeDir, 'skills'))) throw new Error(`${claudeDir} is not a .claude directory with skills/`);
  const { tiers, doctor } = config(claudeDir);
  const work = join(claudeDir, 'work');
  const checks = [];
  const add = (name, status, detail, fix = null) => checks.push({ name, status, detail, fix });
  const t = { timeoutMs: doctor.timeoutMs };

  // the toolchain
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'fail', `node ${process.versions.node} at ${process.execPath}`, major >= 18 ? null : 'Node 18+ is needed for the scripts (README § Install)');
  const git = cmd(['git', '--version'], t);
  add('git', git.code === 0 ? 'ok' : 'fail', git.code === 0 ? git.stdout.trim() : git.error || firstLine(git.stderr), git.code === 0 ? null : 'install git');

  // the pipeline's own files
  const tiersFile = join(claudeDir, 'tiers.json');
  if (!isFile(tiersFile)) add('tiers.json', 'fail', 'missing', `node ${claudeDir}/skills/_lib/model.mjs tiers ${claudeDir} low=<model> medium=<model> high=<model>`);
  else if (!readJson(tiersFile)) add('tiers.json', 'fail', 'not valid JSON', 'fix the file');
  else {
    const missing = RATINGS.filter((r) => typeof tiers[r] !== 'string' || !tiers[r]);
    const b = { economy: 70, stop: 90, ...(tiers.budget || {}) };
    if (missing.length) add('tiers.json', 'fail', `no model for ${missing.join(', ')}`, `node ${claudeDir}/skills/_lib/model.mjs tiers ${claudeDir} low=… medium=… high=…`);
    else if (!(Number(b.economy) < Number(b.stop) && Number(b.stop) <= 100)) add('tiers.json', 'fail', `budget.economy (${b.economy}) must be below budget.stop (${b.stop}) ≤ 100`, 'fix tiers.json budget');
    else add('tiers.json', 'ok', `${RATINGS.map((r) => `${r}=${tiers[r]}`).join(' ')}`);
    if (!tiers.prices || !RATINGS.some((r) => Number(tiers.prices[r]) >= 0)) add('prices', 'warn', 'tiers.json has no prices: tokens stay unpriced', 'set tiers.json prices { low, medium, high } (currency per 1M tokens) — README § Models and budget, Cost');
  }
  const notify = readJson(join(claudeDir, 'notify.json'));
  if (!isFile(join(claudeDir, 'notify.json'))) add('notify', 'warn', 'notify.json missing: the first entry point asks for the channel', '/tp-notify setup');
  else if (notify === undefined) add('notify', 'fail', 'notify.json is not valid JSON', 'fix or delete the file');
  else if (!notify.tool) add('notify', 'warn', 'notifications off (no chat tool)', '/tp-notify setup after connecting a chat tool');
  else if (!notify.target) add('notify', 'warn', `${notify.tool} connected, channel not set`, '/tp-notify setup target=<channel>');
  else add('notify', 'ok', `${notify.tool} → ${notify.target}`);
  const office = join(claudeDir, 'office.json');
  if (isFile(office) && readJson(office) === undefined) add('office.json', 'warn', 'not valid JSON: the office uses its defaults', 'fix the file');
  else add('office.json', 'ok', isFile(office) ? 'present' : 'absent (defaults)');

  // the work directory
  try { mkdirSync(work, { recursive: true }); const probe = join(work, `.doctor-${process.pid}`); writeFileSync(probe, 'x'); unlinkSync(probe); add('work', 'ok', work); }
  catch (e) { add('work', 'fail', `${work} is not writable: ${e.message}`, 'fix the permissions'); }
  if (isDir(work)) {
    const stray = readdirSync(work).filter((n) => !n.startsWith('_') && !n.startsWith('.') && !isDir(join(work, n)));
    if (stray.length) add('work root', 'warn', `stray file(s) at the work root: ${stray.join(', ')} — an agent logged outside its ticket`, `inspect and remove: ${stray.map((n) => join(work, n)).join(' ')}`);
    const noProgress = readdirSync(work).filter((n) => !n.startsWith('_') && isDir(join(work, n)) && !isFile(join(work, n, 'progress.md')));
    if (noProgress.length) add('work directories', 'warn', `no progress.md in ${noProgress.join(', ')} — not a ticket the state script can read`, 'remove the directory, or restore progress.md');
    const all = cmd([process.execPath, join(HERE, 'state.mjs'), 'all', work], { timeoutMs: 60000 });
    let rows = null; try { rows = JSON.parse(all.stdout); } catch { rows = null; }
    if (all.code !== 0 || !Array.isArray(rows)) add('scripts', 'fail', `state.mjs all failed: ${firstLine(all.stderr) || all.error || 'no JSON'}`, 'node --test the tests (README § Install, step 4)');
    else {
      add('scripts', 'ok', `state.mjs reads ${rows.length} ticket(s)`);
      const errors = rows.filter((r) => r.status === 'error');
      if (errors.length) add('tickets', 'warn', errors.map((r) => `${r.id}: ${(r.problems || []).join('; ')}`).join(' | '), '/tp-status problems');
      const problems = rows.filter((r) => r.status !== 'error' && (r.problems || []).length);
      if (problems.length) add('problems', 'warn', problems.map((r) => `${r.id}: ${r.problems.join('; ')}`).join(' | '), '/tp-status problems — an error stop each: fix, then answers=retry');
      const stale = rows.filter((r) => r.lock?.stale);
      if (stale.length) add('locks', 'warn', `stale run lock on ${stale.map((r) => `${r.id} (${r.lock.owner})`).join(', ')}`, stale.map((r) => `node ${claudeDir}/skills/_lib/state.mjs unlock ${join(work, r.id)} ${r.lock.owner}`).join(' ; '));
      const orphans = rows.filter((r) => (r.status === 'done' || r.status === 'closed') && (r.worktrees || []).length);
      if (orphans.length) add('worktrees', 'warn', `finished tickets still holding a worktree: ${orphans.map((r) => `${r.id} (${r.worktrees.join(', ')})`).join('; ')}`, '/tp-status lists the exact cleanup commands');
    }
    const budget = readJson(join(work, '_budget.json'));
    if (budget?.at) { const age = (Date.now() - Date.parse(budget.at)) / 3600000; add('budget', age > 24 ? 'warn' : 'ok', `last usage reading ${budget.band} (${Math.round(age * 10) / 10} h ago)`, age > 24 ? 'the next spawn records a fresh one (model.mjs pick)' : null); }
    else add('budget', 'ok', 'no usage reading yet — the first spawn records one');
  }

  // the repos and their remotes
  const repos = repoPaths(claudeDir, opts.repos);
  if (!repos.length) add('repos', 'warn', 'no git checkout found at or under the folder that holds .claude, and no ticket names one', 'run the doctor from the project folder, or pass --repos');
  for (const p of repos) {
    const name = basename(p);
    const inside = cmd(['git', '-C', p, 'rev-parse', '--is-inside-work-tree'], t);
    if (inside.code !== 0) { add(`repo ${name}`, 'fail', `${p} is not a git checkout`, 'check the path'); continue; }
    const remote = cmd(['git', '-C', p, 'remote', 'get-url', 'origin'], t);
    if (remote.code !== 0) { add(`repo ${name}`, 'warn', 'no origin remote', 'add one, or the pipeline cannot push'); continue; }
    const base = baseOf(claudeDir, p, doctor.timeoutMs);
    const ls = cmd(['git', '-C', p, 'ls-remote', '--heads', 'origin', ...(base ? [base] : [])], t);
    if (ls.code !== 0) add(`repo ${name}`, 'fail', `origin unreachable: ${ls.error || firstLine(ls.stderr) || `exit ${ls.code}`}`, 'the identity or credential this remote needs — a key to load, a token to renew — never a change to remotes or ssh config (README § Remote access failures)');
    else if (base && !ls.stdout.trim()) add(`repo ${name}`, 'fail', `origin has no branch "${base}" (the base the tickets record)`, 'check the base branch in the conventions file and ticket.json');
    else add(`repo ${name}`, 'ok', `${remote.stdout.trim()}${base ? ` · base ${base}` : ''}`);
    const wt = cmd(['git', '-C', p, 'worktree', 'list', '--porcelain'], t);
    const prunable = (wt.stdout.match(/^prunable/gm) || []).length;
    if (prunable) add(`worktrees ${name}`, 'warn', `${prunable} worktree entr${prunable === 1 ? 'y' : 'ies'} whose directory is gone`, `git -C ${p} worktree prune`);
    // generated code the gates and the build depend on (README § Toolchain): stale is the classic invented-findings trap
    try {
      const g = codegenStatus({ repo: p, claudeDir });
      if (!g.command) add(`generated code ${name}`, 'ok', g.source);
      else if (g.stale) add(`generated code ${name}`, 'warn', `${g.generator || 'generated code'} is behind: ${g.why}`, `run it in ${p}: ${g.command} (then node <.claude>/skills/_lib/codegen.mjs mark '{ "repo": "${p}", "claudeDir": "${claudeDir}" }')`);
      else add(`generated code ${name}`, 'ok', `${g.generator || 'generated'} current (${g.command})`);
    } catch (e) { add(`generated code ${name}`, 'warn', `codegen.mjs could not check: ${firstLine(e.message)}`); }
    // the gates this repo's own hooks own: every one of them is a gate the pipeline never runs (README § Verification rules)
    try {
      const h = hookCover({ repo: p, claudeDir });
      if (!h.trust) add(`hooks ${name}`, 'warn', 'tiers.json hooks.trust is false: every gate runs in the pipeline', 'set it back to true once the hooks are trusted');
      else if (!h.gates.length) add(`hooks ${name}`, 'warn', `no gate is enforced by a git hook (${h.hooks.length ? `hooks: ${h.hooks.join(', ')}` : 'no hooks'})`, '/tp-setup writes them from the project\'s own commands (hooks.mjs plan/install)');
      else add(`hooks ${name}`, 'ok', `${h.gates.join(', ')} enforced by ${[...new Set(Object.values(h.covered).map((c) => c.hook))].join(' + ')}`);
    } catch (e) { add(`hooks ${name}`, 'warn', `hooks.mjs could not read the hooks: ${firstLine(e.message)}`); }
  }

  // the checks the install named (the hosting CLI's auth, a package manager, …)
  for (const c of doctor.checks) {
    const r = cmd(c.run, t);
    const out = `${r.stdout}\n${r.stderr}`;
    const ok = r.code === 0 && (!c.expect || out.includes(c.expect));
    add(c.name, ok ? 'ok' : 'fail', ok ? firstLine(r.stdout) || 'ok' : r.error || firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`, ok ? null : c.fix || `run: ${c.run.join(' ')}`);
  }
  if (!doctor.checks.length) add('platform CLI', 'warn', 'no hosting-CLI check configured', 'tiers.json doctor.checks — e.g. { "name": "hosting CLI", "run": ["<cli>", "auth", "status"] } (README § Install, step 2)');

  // the active skills (pipeline.json, /tp-setup): every skill on has its folder, every dependency is on
  try {
    const sk = skillsStatus(claudeDir);
    if (sk.problems.length) add('skills', 'fail', sk.problems.join('; '), '/tp-setup (or node <.claude>/skills/_lib/setup.mjs apply) puts the folders where pipeline.json says');
    else add('skills', 'ok', sk.pipeline ? `${sk.on.length} on, ${sk.off.length} off (${sk.pipeline.setAt})` : `every skill on (no pipeline.json — /tp-setup picks a selection)`);
  } catch (e) { add('skills', 'warn', `setup.mjs could not read the skills: ${firstLine(e.message)}`); }

  // the runtime's allowlist
  const allow = ['settings.json', 'settings.local.json'].flatMap((f) => { const s = readJson(join(claudeDir, f)); return Array.isArray(s?.permissions?.allow) ? s.permissions.allow : []; });
  if (!allow.length) add('allowlist', 'warn', 'no permissions.allow in settings.json or settings.local.json: every pipeline command will prompt', 'README § Install, step 2');
  else {
    const missing = expectedRules(claudeDir).filter((r) => !covered(r, allow));
    if (missing.length) add('allowlist', 'warn', `${missing.length} of the Install rules missing: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`, 'add them to permissions.allow (README § Install, step 2)');
    else add('allowlist', 'ok', `${allow.length} rules, the Install set covered`);
  }

  // the tests, on request
  if (opts.tests) {
    const r = cmd([process.execPath, '--test', join(claudeDir, 'tests', '*.test.mjs')], { timeoutMs: 600000 });
    const summary = /# pass (\d+)[\s\S]*# fail (\d+)/.exec(r.stdout) || /ℹ pass (\d+)[\s\S]*ℹ fail (\d+)/.exec(r.stdout);
    add('tests', r.code === 0 ? 'ok' : 'fail', summary ? `${summary[1]} passed, ${summary[2]} failed` : r.error || `exit ${r.code}`, r.code === 0 ? null : `node --test '${join(claudeDir, 'tests', '*.test.mjs')}'`);
  }

  const out = { at: nowIso(), ok: !checks.some((c) => c.status === 'fail'), node: process.versions.node, claudeDir, checks };
  writeAtomic(join(work, '_doctor.json'), out);
  return out;
}

export function fresh(claudeDir) {
  claudeDir = resolve(claudeDir);
  const { doctor } = config(claudeDir);
  const d = readJson(join(claudeDir, 'work', '_doctor.json'));
  if (!d?.at) return { fresh: false, ok: null, ageHours: null, at: null, why: 'no preflight recorded — /tp-doctor' };
  const ageHours = Math.round(((Date.now() - Date.parse(d.at)) / 3600000) * 10) / 10;
  const isFresh = ageHours <= doctor.maxAgeHours;
  const ok = d.ok !== false && !(d.checks || []).some((c) => c.status === 'fail');
  return { fresh: isFresh, ok, ageHours, at: d.at, why: !isFresh ? `last preflight ${ageHours} h ago (max ${doctor.maxAgeHours}) — /tp-doctor` : !ok ? `the last preflight failed: ${(d.checks || []).filter((c) => c.status === 'fail').map((c) => c.name).join(', ')} — /tp-doctor` : 'preflight fresh and clean' };
}

export function addCheck(claudeDir, payload) {
  claudeDir = resolve(claudeDir);
  const file = join(claudeDir, 'work', '_doctor.json');
  const d = readJson(file);
  if (!d?.at) throw new Error('no preflight recorded yet — run first');
  const c = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!c || typeof c.name !== 'string' || !['ok', 'warn', 'fail'].includes(c.status)) throw new Error('a check needs a name and a status of ok, warn or fail');
  d.checks = (d.checks || []).filter((x) => x.name !== c.name).concat([{ name: c.name, status: c.status, detail: c.detail ?? '', fix: c.fix ?? null }]);
  d.ok = !d.checks.some((x) => x.status === 'fail');
  writeAtomic(file, d);
  return d;
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}
function flags(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) if (String(list[i]).startsWith('--')) o[list[i].slice(2)] = list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[++i] : true;
  return o;
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , sub, target, ...rest] = process.argv;
  try {
    switch (sub) {
      case 'run': { if (!target) throw new Error('usage: doctor.mjs run <.claude> [--repos a,b] [--tests]'); const o = flags(rest); const r = run(target, { repos: o.repos, tests: !!o.tests }); emit(r, r.checks.some((c) => c.status === 'fail') ? 2 : r.checks.some((c) => c.status === 'warn') ? 1 : 0); break; }
      case 'fresh': { if (!target) throw new Error('usage: doctor.mjs fresh <.claude>'); const r = fresh(target); emit(r, !r.fresh ? 1 : !r.ok ? 2 : 0); break; }
      case 'add': { if (!target || !rest[0]) throw new Error('usage: doctor.mjs add <.claude> \'<check>\''); emit(addCheck(target, rest[0])); break; }
      default: console.error('usage: doctor.mjs run|fresh|add <.claude> …'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
}
