#!/usr/bin/env node
// bed.mjs — the scaffold every eval case starts from: a throw-away project in the current directory, built on the simulation bed
// (tests/sim/setup.mjs: two small repos, a `.claude` with tiers.json, the fixture tracker, a silent notify.json), plus the work directory
// state a scenario needs, made by the pipeline's own scripts so it is as valid as a real run's.
//
//   node evals/lib/bed.mjs <scenario>      scenario: empty | picked-up | stopped | in-run
//     empty      the bed alone
//     picked-up  DEMO-4's work directory as /tp:start-ticket leaves it: ticket.json, ticket.md, progress.md, a worktree on a fix branch
//     stopped    picked-up, then triage stopped with a question (what /tp:inbox lists)
//     in-run     picked-up, with a live run lock — a call made now counts as part of a run (the guard hooks apply)
// The models are the ceiling's: tiers.json names one model (sonnet), so every agent the pipeline spawns runs on the model the eval does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../../tests/sim/setup.mjs';
import { log } from '../../lib/state/progress.mjs';
import { lockRun } from '../../lib/state/lock.mjs';
import { putArtifact } from '../../lib/state/put.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
const MODEL = process.env.TP_EVAL_MODEL || 'sonnet';

export function bed(dir, scenario) {
  const root = setup(dir, { low: MODEL, medium: MODEL, high: MODEL });
  if (scenario === 'empty') return root;
  const work = join(root.claude, 'work', 'DEMO-4');
  mkdirSync(work, { recursive: true });
  const repo = root.repos.api;
  const worktree = join(work, 'wt', 'api');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'fix/contacts-list-ignores-q-filter', worktree, 'HEAD'], { cwd: repo });
  writeFileSync(join(work, 'ticket.md'), '# DEMO-4 — BE: contacts list ignores the `q` filter\n\nGET /contacts?q=ann returns every contact; it should filter by name.\n\nAcceptance criteria:\n1. GET /contacts?q=ann returns only contacts whose name contains "ann" (case-insensitive)\n2. no q → every contact\n');
  putArtifact(work, 'ticket', {
    id: 'DEMO-4', title: 'BE: contacts list ignores the `q` filter', link: 'fixture://DEMO-4', round: 1, stackedOn: null, dependsOn: null,
    acceptanceCriteria: ['GET /contacts?q=ann returns only contacts whose name contains "ann" (case-insensitive)', 'no q → every contact'],
    derived: false, complexity: 'low',
    repos: [{ name: 'api', path: repo, worktree, branch: 'fix/contacts-list-ignores-q-filter', base: 'main', conventions: join(repo, 'CLAUDE.md') }],
  });
  log(work, 'start-ticket', 'started', 'DEMO-4 pickup', '');
  log(work, 'start-ticket', 'done', 'picked up; fix/contacts-list-ignores-q-filter in api', 'fixture://DEMO-4');
  if (scenario === 'stopped') {
    log(work, 'triage', 'started', '', '');
    log(work, 'triage', 'stopped', 'Should GET /contacts?q= match the email as well as the name? Default: the name only.', '');
  }
  if (scenario === 'in-run') lockRun(work, 'eval-run');
  return root;
}

function isMain(url) { try { return resolve(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const scenario = process.argv[2];
  if (!['empty', 'picked-up', 'stopped', 'in-run'].includes(scenario)) { console.error('usage: bed.mjs empty|picked-up|stopped|in-run'); process.exit(2); }
  bed(process.cwd(), scenario);
}
