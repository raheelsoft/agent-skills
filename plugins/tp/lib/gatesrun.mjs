#!/usr/bin/env node
// gatesrun.mjs — /tp:verify for the case that needs no judgment: every gate passes. Reuse a recorded result, leave the gates the repo's hooks own to the
// hooks, bring generated code up to date, resolve each gate to the project's own command, run them concurrently as processes with their output in files,
// and — when all pass and nothing was rewritten — render the table and record the result. A pass is a pass whatever the base looked like, so no baseline is
// needed; the moment anything fails, rewrites a file or cannot be run, the answer is `needs-agent` with what was found, and the verify agent takes it from there
// (the baseline comparison, the autofix reading, the environment errors — the parts that do take judgment). The common all-green run costs no model turn at all.
//
//   node gatesrun.mjs '{ repo, path?, base, remote?, tests?, readonly?, full?, claudeDir }'
//     repo: the repository (keys the recorded results); path: the checkout to gate (a ticket's worktree; default repo); base: the base branch
//   -> { status: "reused"|"pass", table, verdict, gates, record? }
//    | { status: "needs-agent", why, failures: [{ gate, command, exit, tail }], ran: [...] }
//    | { status: "error", error }                    exit 0 reused/pass, 1 needs-agent, 2 error
// Gates are Types, Lint, Build and (with tests:true) Tests; a rewriting command runs in the resolver's check-only form, or is left to the agent.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cover, gatesOf } from './githooks/index.mjs';
import { status as codegenStatus, mark as codegenMark } from './codegen.mjs';
import { resultGet, resultPut } from './gates.mjs';

// the folder of the node running this script goes first on the PATH of every gate: where node is, npm and npx are (a sandbox or a broken shell wrapper may not say so)
const toolEnv = (extra = []) => ({ ...process.env, PATH: [...extra, dirname(process.execPath), process.env.PATH || ''].join(delimiter), CI: '1', FORCE_COLOR: '0' });
/** Is `name` resolvable on the PATH a gate gets? A sandbox or a broken shell wrapper can hide npm while node still runs. */
const onPath = (name, cwd) => spawnSync('sh', ['-c', `command -v ${name}`], { cwd, env: toolEnv(), stdio: 'ignore' }).status === 0;
const RUNNERS = ['npm', 'pnpm', 'yarn', 'bun'];
/** The command a gate runs: the resolver's, or — when its package runner is not on the PATH — the script's own body, which is all `npm run` does (npx/pnpm exec prefixes dropped; node_modules/.bin on the PATH). */
export function commandOf(g, cwd, has = onPath) {
  const base = g.rewrites ? g.check : g.cmd;
  if (!base) return { command: null };
  const runner = RUNNERS.includes(g.runner) ? g.runner : null;
  const exec = String(g.exec || '').split(' ')[0];
  if (runner && !has(runner, cwd) && g.body) {
    const body = g.rewrites ? base : g.body;
    const bare = body.replace(/^(npx|pnpm exec|yarn|bunx)\s+/, '');
    return { command: bare, extraPath: [join(cwd, 'node_modules', '.bin')], viaBody: true };
  }
  if (exec && base.startsWith(exec) && !has(exec, cwd) && g.rewrites) return { command: base.replace(/^(npx|pnpm exec|yarn|bunx)\s+/, ''), extraPath: [join(cwd, 'node_modules', '.bin')], viaBody: true };
  return { command: base, extraPath: [] };
}
const NAMES = { types: 'Types', lint: 'Lint', build: 'Build', tests: 'Tests' };
const TIMEOUT_MS = 20 * 60 * 1000;
const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const porcelain = (cwd) => { const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.replace(/\n+$/, '') : ''; };
const tail = (file, n = 20) => { try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };

/** Run one command in `cwd` with its output in `file`; resolves { exit, ms }. */
function run(command, cwd, file, extraPath = []) {
  return new Promise((done) => {
    const t0 = Date.now();
    const fd = openSync(file, 'w');
    const p = spawn(command, { cwd, shell: true, stdio: ['ignore', fd, fd], env: toolEnv(extraPath) });
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.on('close', (code) => { clearTimeout(timer); closeSync(fd); done({ exit: code ?? 137, ms: Date.now() - t0 }); });
    p.on('error', () => { clearTimeout(timer); closeSync(fd); done({ exit: 127, ms: Date.now() - t0 }); });
  });
}

/** The table, in the shape /tp:verify reports (skills/verify/SKILL.md § Report). */
export function renderTable(project, rows, { skipped = [], reused = null } = {}) {
  const L = [`## Verification Results — ${project}`, '', '| Gate  | Status | Notes |', '|-------|--------|-------|', ...rows.map((r) => `| ${r.gate} | ${r.status} | ${r.notes || ''} |`), ''];
  const hooks = rows.filter((r) => r.status === 'HOOK').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  L.push(`**Verdict:** ${failed ? `${failed} GATE${failed > 1 ? 'S' : ''} FAILED` : 'ALL GATES PASSED'}`);
  if (hooks) L.push('', `${hooks} gate${hooks > 1 ? 's' : ''} enforced by the repo's hooks, not run here.`);
  if (skipped.length) L.push('', `Not run: ${skipped.join(', ')} (the project defines no such command).`);
  if (reused) L.push('', `reused — recorded ${reused}`);
  return L.join('\n');
}

export async function gatesRun(input) {
  const repo = resolve(String(input?.repo || ''));
  const path = resolve(String(input?.path || repo));
  const claudeDir = input?.claudeDir;
  if (!input?.repo || !input?.base || !claudeDir) return { status: 'error', error: 'usage: gatesrun.mjs \'{ "repo", "base", "claudeDir", "path"?, "remote"?, "tests"?, "readonly"?, "full"? }\'' };
  const remote = input.remote || 'origin';
  const head = git(path, ['rev-parse', 'HEAD']);
  const baseSha = git(path, ['rev-parse', '--verify', '--quiet', `${remote}/${input.base}`]) || git(path, ['rev-parse', '--verify', '--quiet', input.base]);
  if (!head || !baseSha) return { status: 'error', error: `cannot resolve HEAD or ${input.base} in ${path}` };

  const prior = resultGet({ repo, head, base: baseSha, checkout: path, claudeDir });
  if (prior.code === 0) return { status: 'reused', table: prior.record.table, verdict: prior.record.verdict, gates: prior.record.gates, record: prior.record };

  const covered = input.full ? {} : cover({ repo: path, claudeDir }).covered;
  const pushed = git(path, ['rev-parse', '@{u}']) === head;
  const rows = []; const jobs = []; const skipped = [];
  const resolved = gatesOf(path, claudeDir).gates || {};

  const cg = codegenStatus({ repo: path, claudeDir });
  if (cg.command && cg.stale) {
    mkdirSync(join(claudeDir, 'work', '_scratch', 'gates', basename(repo)), { recursive: true });
    const out = join(claudeDir, 'work', '_scratch', 'gates', basename(repo), 'codegen.txt');
    const r = await run(cg.command, path, out);
    if (r.exit !== 0) return { status: 'error', error: `generating code failed (${cg.command}, exit ${r.exit}): ${tail(out, 6)}` };
    codegenMark({ repo: path, claudeDir });
  }

  for (const gate of ['types', 'lint', 'build', ...(input.tests ? ['tests'] : [])]) {
    const hook = covered[gate];
    if (hook && (hook.hook !== 'pre-push' || pushed)) { rows.push({ gate: NAMES[gate], status: 'HOOK', notes: `${hook.hook} · ${String(hook.command).replace(/\s+/g, ' ').slice(0, 80)}` }); continue; }
    const g = resolved[gate];
    if (!g) { skipped.push(NAMES[gate]); continue; }
    const { command, extraPath } = commandOf(g, path, input._has);
    if (!command) return { status: 'needs-agent', why: `${NAMES[gate]}: \`${g.cmd}\` rewrites files and has no check-only form — the agent decides how to run it`, failures: [], ran: [] };
    jobs.push({ gate, command, extraPath });
  }

  const dir = join(claudeDir, 'work', '_scratch', 'gates', basename(repo), `run-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
  mkdirSync(dir, { recursive: true });
  const before = porcelain(path);
  const results = await Promise.all(jobs.map(async (j) => ({ ...j, ...(await run(j.command, path, join(dir, `${j.gate}.txt`), j.extraPath)), file: join(dir, `${j.gate}.txt`) })));
  const after = porcelain(path);
  for (const r of results) rows.push({ gate: NAMES[r.gate], status: r.exit === 0 ? 'PASS' : 'FAIL', notes: r.exit === 0 ? '' : `exit ${r.exit}` });
  const failures = results.filter((r) => r.exit !== 0).map((r) => ({ gate: NAMES[r.gate], command: r.command, exit: r.exit, tail: tail(r.file), ...(r.exit === 127 ? { environment: { node: process.execPath, path: toolEnv().PATH } } : {}) }));
  const ran = results.map((r) => ({ gate: NAMES[r.gate], exit: r.exit, ms: r.ms }));
  let restored = [];
  if (input.readonly && after !== before) { // a checkout that is not ours to change: put back what a gate rewrote
    const was = new Set(before.split('\n').map((l) => l.slice(3)));
    restored = after.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((p) => !was.has(p));
    for (const f of restored) git(path, ['checkout', '--', f]);
  }
  if (failures.length || after !== before) {
    const why = failures.length ? `${failures.map((f) => f.gate).join(', ')} failed: the base comparison and the diagnosis take judgment` : `the gates changed files in the checkout (${after.split('\n').slice(0, 3).join(', ')}): reading what an autofix did takes judgment`;
    return { status: 'needs-agent', why, failures, ran, runDir: dir, ...(restored.length ? { restored } : {}) };
  }
  rmSync(dir, { recursive: true, force: true });

  const order = ['Types', 'Lint', 'Build', 'Tests'];
  rows.sort((a, b) => order.indexOf(a.gate) - order.indexOf(b.gate));
  const table = renderTable(basename(repo), rows, { skipped });
  const gates = Object.fromEntries(rows.map((r) => [r.gate.toLowerCase(), r.status]));
  const rec = resultPut({ repo, head, base: baseSha, verdict: 'ALL GATES PASSED', table, gates, checkout: path, claudeDir });
  return { status: 'pass', table, verdict: 'ALL GATES PASSED', gates, record: rec.code ? null : rec.record, recorded: !rec.code, ran };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  let input;
  try { input = JSON.parse(process.argv[2] || '{}'); } catch (e) { console.error(`the argument is not JSON: ${e.message}`); process.exit(2); }
  const r = await gatesRun(input);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.status === 'error' ? 2 : r.status === 'needs-agent' ? 1 : 0);
}
