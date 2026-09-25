// Shared helpers for the pipeline's script tests. Node's built-in runner, no dependencies:
//   node --test <.claude>/tests/
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE = join(CLAUDE_DIR, 'skills', '_lib', 'state.mjs');
export const WORKFLOW = join(CLAUDE_DIR, 'workflows', 'tp-run-ticket-unattended.js');
export const SERVE = join(CLAUDE_DIR, 'office', 'serve.mjs');
export const DAY = join(CLAUDE_DIR, 'skills', '_lib', 'day.mjs');
export const SEP = ' · ';

/** A throw-away root; `t.after(() => rm(root))` cleans it. */
export function tmp(prefix = 'pipeline-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function rm(path) {
  rmSync(path, { recursive: true, force: true });
}

/** Run the state script; returns { code, stdout, stderr, json } (json when stdout parses). */
export function state(...args) {
  const r = spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON (log / lock output) */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Run the day planner's script; same shape as `state`. */
export function day(...args) {
  const r = spawnSync(process.execPath, [DAY, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage errors print nothing parseable */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function writeJson(dir, name, obj) {
  writeFileSync(join(dir, name), JSON.stringify(obj, null, 2) + '\n');
}
export function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}
export function touch(dir, name, content = 'x\n') {
  writeFileSync(join(dir, name), content);
}

/** Write progress.md from [ts, stage, event, summary?, links?] rows (bypasses `log`, so timestamps are chosen). */
export function progress(dir, rows) {
  const lines = rows.map((r) => (typeof r === 'string' ? r : '- ' + r.join(SEP)));
  writeFileSync(join(dir, 'progress.md'), '# progress\n\n' + lines.join('\n') + '\n');
}

/** A minimal single- or multi-repo ticket.json. repos: [{ name, worktree?, branch? }] */
export function ticket(dir, repos = [{ name: 'r' }], extra = {}) {
  const t = {
    id: 'T-1', title: 'a ticket', link: 'https://tracker/T-1', round: 1, stackedOn: null,
    acceptanceCriteria: ['it works'], derived: false,
    repos: repos.map((r) => ({ name: r.name, path: r.path || `/repos/${r.name}`, worktree: r.worktree || null, branch: r.branch || 'feat/t', base: 'main', conventions: null })),
    ...extra,
  };
  writeJson(dir, 'ticket.json', t);
  touch(dir, 'ticket.md');
  return t;
}

/** A git repo with one commit and a worktree on `branch`; returns { repo, worktree }. */
export function gitRepoWithWorktree(root, name = 'r', branch = 'feat/t') {
  const repo = join(root, `${name}-repo`);
  const worktree = join(root, `${name}-wt`);
  mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']);
  return { repo, worktree, git };
}

/** A work directory whose pickup is complete (start-ticket done with its files). */
export function pickedUp(root, opts = {}) {
  const dir = join(root, 'work', opts.id || 'T-1');
  mkdirSync(dir, { recursive: true });
  ticket(dir, opts.repos, { id: opts.id || 'T-1', ...(opts.extra || {}) });
  progress(dir, [
    ['2026-01-01T10:00Z', 'start-ticket', 'started'],
    ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up'],
  ]);
  return dir;
}

/** Append rows to an existing progress.md. */
export function append(dir, rows) {
  const file = join(dir, 'progress.md');
  const lines = rows.map((r) => '- ' + r.join(SEP)).join('\n') + '\n';
  writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '# progress\n\n') + lines);
}

/** The standard artefacts a done stage must leave behind. */
export const ARTEFACTS = {
  triage: (dir, decision = 'direct') => { writeJson(dir, 'triage.json', { decision, confidence: 'high', override: null, flags: [], questions: [] }); touch(dir, 'triage.md'); },
  plan: (dir, plan = {}) => { writeJson(dir, 'plan.json', { status: 'ready', flags: [], steps: 2, openQuestions: 0, ...plan }); touch(dir, 'plan.md'); },
  check: (dir, check = {}) => writeJson(dir, 'plan-check.json', { verdict: 'ok', findings: [], ...check }),
  implement: (dir, repo = null) => writeJson(dir, repo ? `implement.${repo}.json` : 'implement.json', { repo: repo || 'r', done: 2, total: 2, commits: [], gates: {}, deviations: 0, stopped: null }),
  pr: (dir, repo = null, extra = {}) => { writeJson(dir, repo ? `pr.${repo}.json` : 'pr.json', { repo: repo || 'r', url: 'https://host/pr/1', number: 1, round: 1, reviewRounds: 1, reviews: [], verdict: 'PASS', merged: 'abc123', ...extra }); touch(dir, 'report.md'); },
  release: (dir, repo = null) => writeJson(dir, repo ? `release.${repo}.json` : 'release.json', { repo: repo || 'r', sameAs: null, run: null, env: null, followUps: [], smoke: [], promoted: null }),
  accept: (dir) => { writeJson(dir, 'accept.json', { where: 'checkout', targets: [], criteria: [], passed: 1, failed: 0, manual: 0 }); touch(dir, 'accept.md'); },
};

/** Stage status by name from a `state` result. */
export function stageOf(json, name) {
  return json.stages.find((s) => s.name === name);
}
export function statuses(json) {
  return Object.fromEntries(json.stages.map((s) => [s.name, s.status]));
}

/** ISO minute stamp `ms` in the past, in the script's format. */
export function stampAgo(ms) {
  return new Date(Date.now() - ms).toISOString().slice(0, 16) + 'Z';
}

/** `<root>/office.json` — the fake <.claude>'s office configuration (root = dirname of the work root). */
export function officeConfig(root, obj) {
  writeJson(root, 'office.json', obj);
}
/** Register an agent through the state script; returns its record. */
export function joinAgent(workroot, rec) {
  return state('agent', 'join', workroot, JSON.stringify(rec));
}
export function leaveAgent(workroot, id, status) {
  return status ? state('agent', 'leave', workroot, id, status) : state('agent', 'leave', workroot, id);
}
