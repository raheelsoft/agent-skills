#!/usr/bin/env node
// coverage.mjs — is the plan 100% implemented, and is every acceptance criterion proved? The plan makes two promises: each step names the files it
// changes, and § Verification maps every numbered criterion to a check (contract/proof.mjs). This reads the change in the ticket's worktree and the gate
// result recorded for its head and says, step by step and criterion by criterion, whether the promise was kept — on the developer's machine, from
// `git diff` and the files, so "done" is a measurement and not the implementer's word. It never runs a test or a command: the gates do that, and
// their record for this exact commit is what `tests` is read from.
//
//   node coverage.mjs <workdir> [--repo <name>] [--claude <.claude>] [--render]
//   { plan: true, repo, head, base, complete, percent: { steps, criteria }, steps: [{ n, name, status: done|partial|missing, files: [{ path, kind, state }] }],
//     criteria: [{ n, text, status: covered|manual|missing, checks: [{ type, ref, state, evidence? }] }], gates: { <gate>: "PASS"|"FAIL"… } | null,
//     testsGreen: true|false|null, gaps: ["…"] }
// `complete` is true when every step is done, no criterion is missing and no recorded gate failed. A ticket without a plan.md (direct work) reports
// `{ plan: false }`: there is nothing to measure it against. `--render` prints the proof matrix as the markdown a report or a review carries.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './contract/plan.mjs';
import { checksOf } from './contract/proof.mjs';
import { recordAt } from './gates.mjs';

const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const clean = (p) => String(p).replace(/^\.\//, '').replace(/^\/+/, '');

/** Path → status (A|M|D|R) of everything the branch changes against `base`, plus uncommitted changes. */
function changedFiles(wt, base) {
  const out = new Map();
  const add = (text) => {
    const parts = (text || '').split('\0');
    for (let i = 0; i < parts.length - 1;) {
      const code = parts[i++];
      if (!code) continue;
      if (code[0] === 'R' || code[0] === 'C') { i++; out.set(parts[i++], 'R'); } else out.set(parts[i++], code[0]);
    }
  };
  if (base) add(git(wt, ['diff', '--name-status', '-z', '-M', `${base}...HEAD`]));
  add(git(wt, ['diff', '--name-status', '-z', '-M', 'HEAD']));
  for (const l of (git(wt, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean)) out.set(l, 'A');
  return out;
}

/** The ref to compare against: the remote's copy of the base when there is one. */
function baseRef(wt, base) {
  if (!base) return null;
  const bare = String(base).replace(/^origin\//, '');
  return git(wt, ['rev-parse', '--verify', '--quiet', `origin/${bare}`]) ? `origin/${bare}` : git(wt, ['rev-parse', '--verify', '--quiet', bare]) ? bare : null;
}

function stepState(file, changed, wt, several) {
  const p = clean(file.path);
  if (file.path.endsWith('/')) return [...changed.keys()].some((c) => c.startsWith(p)) ? 'done' : 'missing';
  const st = changed.get(p);
  if (!st) return several && !existsSync(join(wt, dirname(p))) ? 'other-repo' : 'missing';
  if (file.kind === 'new' && st !== 'A' && st !== 'R') return 'present';
  return 'done';
}

/** One test check against the worktree: the file exists and, when a name is given, the name appears in it. */
function testState(wt, check, changed) {
  const p = clean(check.path);
  const abs = [join(wt, p), ...(isAbsolute(check.path) ? [check.path] : [])].find(isFile);
  if (!abs) return { state: 'missing', why: `${check.path} is not in the worktree` };
  if (check.name) {
    let body = ''; try { body = readFileSync(abs, 'utf8'); } catch { /* unreadable: the name cannot be found */ }
    if (!body.includes(check.name)) return { state: 'missing', why: `"${check.name}" does not appear in ${check.path}` };
  }
  const st = changed.get(p);
  return { state: 'ok', evidence: st === 'A' ? 'added' : st ? 'changed' : 'existing' };
}

export function coverage({ workdir, repo, claudeDir }) {
  const planFile = join(workdir, 'plan.md');
  if (!existsSync(planFile)) return { plan: false };
  const plan = parsePlan(readFileSync(planFile, 'utf8'));
  let ticket = {}; try { ticket = JSON.parse(readFileSync(join(workdir, 'ticket.json'), 'utf8')); } catch { /* no ticket.json */ }
  const rows = (ticket.repos || []).filter((r) => !r.discarded);
  const row = (repo ? rows.find((r) => r.name === repo) : rows.length === 1 ? rows[0] : null);
  if (!row?.worktree || !existsSync(row.worktree)) return { plan: true, complete: null, gaps: [repo || rows.length > 1 ? 'name the repo (--repo) — the ticket has several' : 'the ticket has no worktree to measure'] };
  const wt = row.worktree;
  const ref = baseRef(wt, row.base);
  const changed = changedFiles(wt, ref);
  const head = git(wt, ['rev-parse', 'HEAD']);

  // the plan is one list of steps for every repo; a step whose files all live in another repo is not this repo's
  const mine = (f) => !f.path.startsWith('/') || f.path.startsWith(wt);
  const steps = plan.steps.map((s) => {
    const files = (s.files || []).filter(mine).map((f) => ({ path: f.path, kind: f.kind, state: stepState(f, changed, wt, rows.length > 1) })).filter((f) => f.state !== 'other-repo');
    const missing = files.filter((f) => f.state === 'missing').length;
    return { n: s.n, name: s.name, status: !files.length ? 'done' : missing === 0 ? 'done' : missing === files.length ? 'missing' : 'partial', files, ...(s.commit?.folded ? { foldedInto: s.commit.folded } : {}) };
  });

  const { checks } = checksOf(plan);
  const mapped = checks.length > 0; // a plan from before § Verification mapped criteria to checks has nothing to measure them by
  const criteria = plan.criteria.map((c) => {
    const mine_ = checks.filter((k) => k.criterion === c.n).map((k) => {
      if (k.type === 'test') return { type: 'test', ref: `${k.path}${k.name ? ` "${k.name}"` : ''}`, ...(k.path ? testState(wt, k, changed) : { state: 'missing', why: 'no file named' }) };
      if (k.type === 'manual') return { type: 'manual', ref: `manual ${k.manual}`, state: 'manual' };
      return { type: 'command', ref: k.command || '', state: 'command' };
    });
    const automated = mine_.some((k) => k.state === 'ok' || k.state === 'command');
    const status = !mapped ? 'unmapped' : automated ? 'covered' : mine_.some((k) => k.state === 'manual') ? 'manual' : 'missing';
    return { n: c.n, text: c.text, status, checks: mine_ };
  });

  const rec = head ? recordAt({ repo: row.path || wt, head, claudeDir: claudeDir || (dirname(dirname(resolve(workdir)))) }) : null;
  const gates = rec?.gates && typeof rec.gates === 'object' ? rec.gates : null;
  const failed = gates ? Object.entries(gates).filter(([, v]) => /^fail/i.test(String(v))).map(([k]) => k) : [];
  const testsGreen = gates ? (gates.tests === undefined ? null : !/^fail/i.test(String(gates.tests))) : null;

  const gaps = [];
  for (const s of steps) if (s.status !== 'done') gaps.push(`step ${s.n} (${s.name}): ${s.files.filter((f) => f.state === 'missing').map((f) => f.path).join(', ')} not changed`);
  for (const c of criteria) if (c.status === 'missing') gaps.push(`criterion ${c.n}: ${c.checks.length ? c.checks.filter((k) => k.state === 'missing').map((k) => k.why).join('; ') : 'no check maps to it'}`);
  if (failed.length) gaps.push(`recorded gate(s) failing for ${String(head).slice(0, 7)}: ${failed.join(', ')}`);
  const pct = (list, ok) => (list.length ? Math.round((100 * list.filter(ok).length) / list.length) : 100);
  return {
    plan: true, repo: row.name, head, base: ref, complete: gaps.length === 0,
    percent: { steps: pct(steps, (s) => s.status === 'done'), criteria: mapped ? pct(criteria, (c) => c.status !== 'missing') : null },
    steps, criteria, gates, testsGreen, gaps,
  };
}

/** The proof matrix as markdown. */
export function renderCoverage(r) {
  if (!r.plan) return 'No plan.md: nothing to measure the change against.';
  if (r.complete === null) return `Coverage not measured: ${r.gaps.join('; ')}`;
  const L = [`Plan coverage — steps ${r.percent.steps}% · criteria ${r.percent.criteria === null ? 'unmapped' : `${r.percent.criteria}%`} · ${r.complete ? 'complete' : `${r.gaps.length} gap(s)`}${r.testsGreen === false ? ' · tests FAIL' : r.testsGreen ? ' · tests PASS' : ''}`, ''];
  L.push('| Step | Status | Files |', '|---|---|---|');
  for (const s of r.steps) L.push(`| ${s.n} ${s.name} | ${s.status} | ${s.files.map((f) => `${f.path} (${f.state})`).join(', ') || '—'} |`);
  L.push('', '| Criterion | Status | Proof |', '|---|---|---|');
  for (const c of r.criteria) L.push(`| ${c.n} ${String(c.text).slice(0, 80)} | ${c.status} | ${c.checks.map((k) => `${k.type}: ${k.ref}${k.evidence ? ` (${k.evidence})` : ''}${k.state === 'missing' ? ' — MISSING' : ''}`).join('; ') || '—'} |`);
  if (r.gaps.length) L.push('', 'Gaps', ...r.gaps.map((g) => `- ${g}`));
  return L.join('\n');
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const workdir = a.find((x, i) => !x.startsWith('--') && !['--repo', '--claude'].includes(a[i - 1]));
  if (!workdir) { console.error('usage: coverage.mjs <workdir> [--repo <name>] [--claude <.claude>] [--render]'); process.exit(2); }
  const r = coverage({ workdir, repo: flag('--repo'), claudeDir: flag('--claude') });
  console.log(a.includes('--render') ? renderCoverage(r) : JSON.stringify(r, null, 2));
  process.exit(r.complete === false ? 1 : 0);
}
