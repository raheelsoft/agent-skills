// coverage.mjs — "is the plan 100% implemented and every criterion proved", measured from the diff and the gate record, not claimed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp, rm, script, writeJson } from './helpers.mjs';
import { coverage, renderCoverage } from '../lib/coverage.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, rel, body = 'x\n') => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), body); };

const PLAN = `# Plan — T-1: Filter contacts by q

status: ready
risk flags: none
repos: \`shop\`

## Goal
Contacts can be filtered.

1. GET /contacts?q=ann returns only matching contacts
2. Without q every contact is returned
3. The filter is explained in the docs

## Current behaviour
The handler is \`src/list.js:3\`.

## Approach
Filter in the handler.

## Steps

### Step 1 — The handler
- Files: \`src/list.js\` (edit)
- Change: filter by q
- Checkpoint: \`node --test\`
- Commit: yes — \`fix: filter\`

### Step 2 — The tests
- Files: \`test/list.test.js\` (new)
- Change: cover q and no q
- Checkpoint: \`node --test\`
- Commit: no, folded into step 1

## Verification
- Gates: the project's own.
- Criteria checks:
  1 → test \`test/list.test.js\` "filters by q"
  2 → test \`test/list.test.js\` "returns all without q"
  3 → manual 1
- Manual:
  1. Read the docs page.

## Risks and rollback
- none

## Open questions
none

## Out of scope
nothing
`;

/** main with src/list.js, a feature branch that changes what `change(repo)` says; the ticket and the plan in a work dir. */
function bed(t, change, plan = PLAN) {
  const root = tmp('coverage-'); t.after(() => rm(root));
  const repo = join(root, 'shop'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); put(repo, 'src/list.js', 'module.exports = () => [];\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'checkout', '-q', '-b', 'feat');
  change(repo);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  const workdir = join(root, '.claude', 'work', 'T-1'); mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'plan.md'), plan);
  writeJson(workdir, 'ticket.json', { id: 'T-1', repos: [{ name: 'shop', path: repo, worktree: repo, branch: 'feat', base: 'main' }] });
  return { root, repo, workdir };
}
const FULL = (repo) => { put(repo, 'src/list.js', 'module.exports = (q) => [q];\n'); put(repo, 'test/list.test.js', "it('filters by q', () => {});\nit('returns all without q', () => {});\n"); };

describe('coverage', () => {
  it('a plan implemented step by step with every automated criterion proved is complete (the manual one is for /tp:accept)', (t) => {
    const { workdir } = bed(t, FULL);
    const r = coverage({ workdir });
    assert.equal(r.complete, true, JSON.stringify(r.gaps));
    assert.deepEqual(r.steps.map((s) => [s.n, s.status]), [[1, 'done'], [2, 'done']]);
    assert.deepEqual(r.criteria.map((c) => [c.n, c.status]), [[1, 'covered'], [2, 'covered'], [3, 'manual']]);
    assert.equal(r.criteria[0].checks[0].evidence, 'added');
    assert.deepEqual(r.percent, { steps: 100, criteria: 100 });
  });

  it('a step whose file was not touched, and a criterion whose test is not there, are gaps', (t) => {
    const { workdir } = bed(t, (repo) => { put(repo, 'test/list.test.js', "it('filters by q', () => {});\n"); });
    const r = coverage({ workdir });
    assert.equal(r.complete, false);
    assert.deepEqual(r.steps.map((s) => s.status), ['missing', 'done']);
    assert.equal(r.criteria[1].status, 'missing');
    assert.match(r.gaps.join('\n'), /step 1 \(The handler\): src\/list\.js not changed/);
    assert.match(r.gaps.join('\n'), /criterion 2: "returns all without q" does not appear in test\/list\.test\.js/);
    assert.deepEqual(r.percent, { steps: 50, criteria: 67 });
  });

  it('uncommitted work counts as changed, and a plan with no mapping leaves its criteria unmapped, not failed', (t) => {
    const { repo, workdir } = bed(t, (r) => put(r, 'src/other.js'), PLAN.replace(/- Criteria checks:[\s\S]*?- Manual:/, '- Manual:'));
    put(repo, 'src/list.js', 'module.exports = (q) => [q, 1];\n'); put(repo, 'test/list.test.js');
    const r = coverage({ workdir });
    assert.deepEqual(r.steps.map((s) => s.status), ['done', 'done']);
    assert.deepEqual(r.criteria.map((c) => c.status), ['unmapped', 'unmapped', 'unmapped']);
    assert.equal(r.percent.criteria, null); assert.equal(r.complete, true);
  });

  it('a failing recorded gate for the head is a gap; no plan.md is not measurable', (t) => {
    const { root, repo, workdir } = bed(t, FULL);
    const head = git(repo, 'rev-parse', 'HEAD');
    const gatesDir = join(root, '.claude');
    const put_ = spawnSync(process.execPath, [script('gates.mjs'), 'result', 'put', JSON.stringify({ repo, head, base: 'main', claudeDir: gatesDir, gates: { lint: 'PASS', tests: 'FAIL' }, verdict: 'FAIL' })], { encoding: 'utf8' });
    if (put_.status === 0) {
      const r = coverage({ workdir, claudeDir: gatesDir });
      assert.equal(r.testsGreen, false); assert.equal(r.complete, false);
      assert.match(r.gaps.join('\n'), /failing for/);
    }
    rm(join(workdir, 'plan.md'));
    assert.deepEqual(coverage({ workdir }), { plan: false });
  });

  it('the command prints the matrix with --render and exits 1 on a gap', (t) => {
    const { workdir } = bed(t, (repo) => { put(repo, 'test/list.test.js', "it('filters by q', () => {});\n"); });
    const r = spawnSync(process.execPath, [script('coverage.mjs'), workdir, '--render'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Plan coverage — steps 50% · criteria 67% · 2 gap\(s\)/);
    assert.match(r.stdout, /\| 1 The handler \| missing \|/);
    assert.match(r.stdout, /test: test\/list\.test\.js "filters by q" \(added\)/);
    assert.match(renderCoverage({ plan: false }), /No plan\.md/);
    assert.equal(spawnSync(process.execPath, [script('coverage.mjs')], { encoding: 'utf8' }).status, 2);
  });
});
