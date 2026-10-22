#!/usr/bin/env node
// bed.mjs — the scaffold every eval case starts from: a throw-away project in the current directory, built on the simulation bed
// (tests/sim/setup.mjs: two small repos, a `.claude` with tiers.json, the fixture tracker, a silent notify.json), plus the work directory
// state a scenario needs, made by the pipeline's own scripts so it is as valid as a real run's.
//
//   node evals/lib/bed.mjs <scenario>      scenario: empty | picked-up | triaged | implemented | pr-open | merged | released | accepted | planned | stopped | in-run
//     empty      the bed alone
//     picked-up  DEMO-4's work directory as /tp:start-ticket leaves it: ticket.json, ticket.md, progress.md, a worktree on a fix branch
//     triaged    picked-up, then triaged as direct work (triage.md, triage.json): what /tp:implement starts from
//     implemented  triaged, then the change made and committed in the worktree, its gate result recorded, the notes and the PR draft written: what /tp:create-pr starts from
//     pr-open    implemented, then pushed and opened as pull request #1 on the fixture hosting platform: what /tp:merge starts from
//     merged     pr-open, then reviewed (PASS) and merged: what /tp:release starts from
//     released   merged, then released (nothing deploys after a merge in this bed): what /tp:accept starts from
//     accepted   released, then accepted and its worktree removed: what /tp:retro starts from
//     planned    picked-up, then triaged as work that needs a plan first (triage.md, triage.json): what /tp:plan starts from
//     stopped    picked-up, then triage stopped with a question (what /tp:inbox lists)
//     in-run     picked-up, with a live run lock — a call made now counts as part of a run (the guard hooks apply)
// The models are the ceiling's: tiers.json names one model (sonnet), so every agent the pipeline spawns runs on the model the eval does.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../../tests/sim/setup.mjs';
import { log } from '../../lib/state/progress.mjs';
import { lockRun } from '../../lib/state/lock.mjs';
import { putArtifact } from '../../lib/state/put.mjs';
import { writeDoc } from '../../lib/state/doc.mjs';
import { resultPut } from '../../lib/gates.mjs';
import { load as loadHosting, create as openPr, merge as mergePr } from '../../lib/hosting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
const MODEL = process.env.TP_EVAL_MODEL || 'sonnet';

const LINE = ['picked-up', 'triaged', 'implemented', 'pr-open', 'merged', 'released', 'accepted']; // each scenario on this line has everything the ones before it have
export const SCENARIOS = ['empty', ...LINE, 'planned', 'stopped', 'in-run'];

const LIST_JS = "export const contacts = [{ id: 1, name: 'Ann', email: 'ann@example.test' }, { id: 2, name: 'Bob', email: 'bob@example.test' }];\n"
  + "export function list(req = {}) {\n  const q = String(req.query?.q ?? '').trim().toLowerCase();\n  return { status: 200, body: q ? contacts.filter((c) => c.name.toLowerCase().includes(q)) : contacts };\n}\n";
const LIST_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { list } from '../src/handlers/list.js';\n\n"
  + "test('q filters by name, case-insensitively', () => assert.deepEqual(list({ query: { q: 'ANN' } }).body.map((c) => c.name), ['Ann']));\n"
  + "test('no q returns every contact', () => assert.equal(list({}).body.length, 2));\n";
const PR_BODY = '## Summary\n\n`GET /contacts` now filters by name when `q` is given (case-insensitive) and returns every contact when it is not — DEMO-4.\n\n'
  + '## Changes\n\n- `src/handlers/list.js`: read `req.query.q`, trim and lower-case it, and keep the contacts whose name contains it.\n- `test/list.test.js`: new — covers both acceptance criteria.\n\n'
  + '## Test plan\n\n- `npm run lint` and `npm test` pass (2 tests).\n- Manual: `/contacts?q=ANN` returns only Ann; `/contacts` returns both.\n';
const BRANCH = 'fix/contacts-list-ignores-q-filter';

export function bed(dir, scenario) {
  const root = setup(dir, { low: MODEL, medium: MODEL, high: MODEL });
  if (scenario === 'empty') return root;
  const work = join(root.claude, 'work', 'DEMO-4');
  mkdirSync(work, { recursive: true });
  const repo = root.repos.api;
  const worktree = join(root.claude, 'worktrees', 'DEMO-4', 'api');
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
  const upTo = (step) => LINE.indexOf(scenario) >= LINE.indexOf(step);
  let head = null; // the commit the change made, once there is one
  if (upTo('triaged')) {
    log(work, 'triage', 'started', '', '');
    writeDoc(work, 'triage.md', '# Triage — DEMO-4\n\n**Decision:** direct (confidence high, complexity low)\n\n## Evidence\n\nThe whole fix is in `src/handlers/list.js`: `list(req)` returns every contact and never reads `req`.\nOne file, one repo, no shared state, access or contract change. The criteria are clear.\n\n## Approach\n\nRead `req.query.q` (absent is fine), lower-case and trim it, and when it is not empty keep the contacts whose name contains it;\notherwise return them all. Add a `node --test` test for both criteria.\n');
    putArtifact(work, 'triage', { decision: 'direct', confidence: 'high', override: 'none', flags: [], questions: [], blockedBy: [], complexity: 'low', why: 'One-file in-memory filter; criteria clear, no shared state, access or contract change.' });
    log(work, 'triage', 'done', 'direct (high) - low', 'triage.md');
  }
  if (upTo('implemented')) {
    // the change /tp:implement would have made: the handler filters, a test pins both criteria, one commit, the gate result recorded, the notes and the PR draft
    log(work, 'implement', 'started', '', '');
    writeFileSync(join(worktree, 'src', 'handlers', 'list.js'), LIST_JS);
    mkdirSync(join(worktree, 'test'), { recursive: true });
    writeFileSync(join(worktree, 'test', 'list.test.js'), LIST_TEST);
    const g = (...a) => execFileSync('git', ['-c', 'user.name=sim', '-c', 'user.email=sim@example.test', ...a], { cwd: worktree, encoding: 'utf8' }).trim();
    g('add', '.'); g('commit', '-q', '-m', 'fix: filter the contacts list by q');
    head = g('rev-parse', 'HEAD');
    resultPut({ repo: worktree, head, base: g('rev-parse', 'origin/main'), verdict: 'PASS', table: '| Gate | Status | Notes |\n|---|---|---|\n| lint | PASS | npm run lint |\n| tests | PASS | npm run test, 2 pass |\n', gates: { lint: 'PASS', tests: 'PASS' }, checkout: worktree, claudeDir: root.claude });
    writeDoc(work, 'plan.md', `# Plan — DEMO-4 (direct work)\n\n## Goal\n\nGET /contacts filters by \`q\`.\n\n## Steps\n\n1. \`src/handlers/list.js\`: filter by name when \`q\` is given.\n2. \`test/list.test.js\`: both acceptance criteria.\n\n## Implementation summary\n\nsteps: 2/2   commits: ${head.slice(0, 7)}\ndeviations: none\ngates: lint PASS; tests PASS\n`);
    putArtifact(work, 'plan', { status: 'ready', flags: [], steps: 2, openQuestions: 0, complexity: 'low' });
    putArtifact(work, 'implement', { repo: 'api', done: 2, total: 2, commits: [`${head.slice(0, 7)} fix: filter the contacts list by q`], gates: { lint: 'PASS', tests: 'PASS' }, deviations: 0, stopped: null, complexity: 'low' });
    writeDoc(work, 'pr-body.md', PR_BODY);
    log(work, 'implement', 'done', '2/2 steps - gates lint PASS, tests PASS', head.slice(0, 7));
  }
  const hostingFile = join(root.claude, 'hosting.fixture.json');
  if (upTo('pr-open')) {
    execFileSync('git', ['push', '-q', '-u', 'origin', BRANCH], { cwd: worktree });
    log(work, 'create-pr', 'started', '', '');
    const pr = openPr(hostingFile, loadHosting(hostingFile), { repo: 'api', head: BRANCH, base: 'main', title: 'fix: filter the contacts list by q', body: PR_BODY });
    putArtifact(work, 'pr', { repo: 'api', url: pr.url, number: pr.number, round: 1, reviewRounds: 0, reviews: [], verdict: null, merged: null });
    writeDoc(work, 'report.md', `# Report — DEMO-4\n\n## create-pr\n\nPR ${pr.url} (round 1). Gates: lint PASS, tests PASS.\n`);
    log(work, 'create-pr', 'done', `PR ${pr.url} round 1`, pr.url);
  }
  if (upTo('merged')) {
    log(work, 'merge', 'started', '', '');
    const m = mergePr(hostingFile, loadHosting(hostingFile), { _: ['1'], repo: 'api' });
    putArtifact(work, 'pr', { repo: 'api', url: m.url, number: 1, round: 1, reviewRounds: 1, reviews: [{ round: 1, sha: head, verdict: 'PASS', open: [], new: [] }], verdict: 'PASS', merged: m.mergeCommit });
    writeDoc(work, 'report.md', `## merge\n\nReview round 1: PASS. Merged ${m.mergeCommit.slice(0, 7)} into main.\n`, { append: true });
    log(work, 'merge', 'done', `merged ${m.mergeCommit.slice(0, 7)}`, m.url);
  }
  if (upTo('released')) {
    log(work, 'release', 'started', '', '');
    putArtifact(work, 'release', { repo: 'api', sameAs: null, run: null, env: null, followUps: [], smoke: [], promoted: null });
    writeDoc(work, 'report.md', '## release\n\nNothing deploys after a merge in this project: no run to watch, no environment to check.\n', { append: true });
    log(work, 'release', 'done', 'nothing deploys after a merge', '');
  }
  if (upTo('accepted')) {
    log(work, 'accept', 'started', '', '');
    const criteria = ['GET /contacts?q=ann returns only contacts whose name contains "ann" (case-insensitive)', 'no q → every contact'];
    putArtifact(work, 'accept', { where: 'checkout', targets: [{ repo: 'api', env: null, checkout: worktree }], criteria: criteria.map((text, i) => ({ n: i + 1, text, result: 'pass', evidence: 'node --test: test/list.test.js passes at the merge commit' })), passed: 2, failed: 0, manual: 0 });
    writeDoc(work, 'accept.md', '# Acceptance — DEMO-4\n\n1. pass — node --test: test/list.test.js passes at the merge commit\n2. pass — the same test file\n');
    log(work, 'accept', 'done', '2 of 2 criteria pass', '');
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo });
    rmSync(join(root.claude, 'worktrees', 'DEMO-4'), { recursive: true, force: true });
  }
  if (scenario === 'planned') {
    log(work, 'triage', 'started', '', '');
    writeDoc(work, 'triage.md', '# Triage — DEMO-4\n\n**Decision:** plan (confidence high, complexity low)\n\n## Evidence\n\nThe bug is in `src/handlers/list.js`: `list(req)` returns every contact and never reads `req`. The fix is small, but the repo has no test setup and no\nconvention yet for how a handler reads its query, so the decisions are written down first.\n\n## Scope notes\n\n- the handler: read `q` from the request query, filter by name, case-insensitive;\n- a first test under `test/` with `node --test`, for both acceptance criteria;\n- no change to the response shape.\n');
    putArtifact(work, 'triage', { decision: 'plan', confidence: 'high', override: 'none', flags: [], questions: [], blockedBy: [], complexity: 'low', why: null, research: { needed: false, questions: [] } });
    log(work, 'triage', 'done', 'plan (high) - low', 'triage.md');
  }
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
  if (!SCENARIOS.includes(scenario)) { console.error(`usage: bed.mjs ${SCENARIOS.join('|')}`); process.exit(2); }
  bed(process.cwd(), scenario);
}
