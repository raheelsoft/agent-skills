// gatesrun.mjs — the all-green verify, with no model turn: reuse, hooks, run, record; anything else is handed to the agent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, script, writeJson } from './helpers.mjs';
import { gatesRun, renderTable, commandOf } from '../lib/gatesrun.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OK = 'node -e "process.exit(0)"';

/** A repo with a commit ahead of main, and a .claude whose tiers.json names the gate commands. */
function bed(t, commands) {
  const root = tmp('gatesrun-'); t.after(() => rm(root));
  const repo = join(root, 'shop'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feat'); writeFileSync(join(repo, 'b.txt'), 'b\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'work');
  const claudeDir = join(root, '.claude'); mkdirSync(join(claudeDir, 'work'), { recursive: true });
  writeJson(claudeDir, 'tiers.json', { hooks: { commands } });
  return { root, repo, claudeDir, input: { repo, base: 'main', claudeDir } };
}

describe('gatesRun', () => {
  it('runs every resolved gate, renders the table and records it; the next call reuses the record', async (t) => {
    const b = bed(t, { types: OK, lint: OK, build: OK });
    const r = await gatesRun(b.input);
    assert.equal(r.status, 'pass', JSON.stringify(r));
    assert.deepEqual(r.gates, { types: 'PASS', lint: 'PASS', build: 'PASS' });
    assert.match(r.table, /\| Types \| PASS \|/); assert.match(r.table, /\*\*Verdict:\*\* ALL GATES PASSED/);
    assert.equal(r.recorded, true);
    const again = await gatesRun(b.input);
    assert.equal(again.status, 'reused'); assert.equal(again.table, r.table);
  });

  it('a gate finds node, npm and npx by the folder of the node that runs the script, whatever the PATH says', async (t) => {
    const b = bed(t, { lint: 'node -v && npm -v' });
    const saved = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try { assert.equal((await gatesRun(b.input)).status, 'pass'); } finally { process.env.PATH = saved; }
  });

  it('when the package runner is not on the PATH, the script\'s own body runs — all `npm run` does', async (t) => {
    const g = { cmd: 'npm run lint', runner: 'npm', body: 'node --check src/app.js', rewrites: false, exec: 'npx' };
    assert.deepEqual(commandOf(g, '/w', () => true), { command: 'npm run lint', extraPath: [] });
    const c = commandOf(g, '/w', () => false);
    assert.deepEqual([c.command, c.viaBody, c.extraPath], ['node --check src/app.js', true, ['/w/node_modules/.bin']]);
    const fix = { cmd: 'npm run lint', runner: 'npm', body: 'eslint . --fix', check: 'npx eslint .', rewrites: true, exec: 'npx' };
    assert.equal(commandOf(fix, '/w', () => false).command, 'eslint .');
    // end to end: a repo whose lint is a package script, run with npm hidden
    const b = bed(t, {});
    writeFileSync(join(b.repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { lint: 'node -e "process.exit(0)"' } }));
    git(b.repo, 'add', '.'); git(b.repo, 'commit', '-q', '-m', 'package');
    const r = await gatesRun({ ...b.input, _has: () => false });
    assert.equal(r.status, 'pass', JSON.stringify(r)); assert.deepEqual(r.gates, { lint: 'PASS' });
  });

  it('a gate the project defines no command for is said to be skipped, not invented', async (t) => {
    const r = await gatesRun(bed(t, { lint: OK }).input);
    assert.equal(r.status, 'pass'); assert.match(r.table, /Not run: Types, Build/);
  });

  it('a failing gate hands the run to the agent with the failure and its output, and records nothing', async (t) => {
    const b = bed(t, { types: OK, lint: 'node -e "console.error(\'src/a.ts:1 bad thing\'); process.exit(3)"', build: OK });
    const r = await gatesRun(b.input);
    assert.equal(r.status, 'needs-agent');
    assert.deepEqual(r.failures.map((f) => [f.gate, f.exit]), [['Lint', 3]]);
    assert.match(r.failures[0].tail, /bad thing/);
    assert.match(r.why, /Lint failed/);
    const again = await gatesRun(b.input);
    assert.equal(again.status, 'needs-agent', 'nothing was recorded, so nothing is reused');
  });

  it('a gate that rewrites a file in the checkout is the agent\'s to read, not a clean pass', async (t) => {
    const b = bed(t, { lint: `node -e "require('fs').writeFileSync('b.txt','fixed\\n')"` });
    const r = await gatesRun(b.input);
    assert.equal(r.status, 'needs-agent'); assert.match(r.why, /changed files in the checkout/);
  });

  it('in a checkout that is not ours, what a gate rewrote is put back', async (t) => {
    const b = bed(t, { lint: `node -e "require('fs').writeFileSync('b.txt','fixed\\n')"` });
    const r = await gatesRun({ ...b.input, readonly: true });
    assert.equal(r.status, 'needs-agent'); assert.deepEqual(r.restored, ['b.txt']);
    assert.equal(readFileSync(join(b.repo, 'b.txt'), 'utf8'), 'b\n');
  });

  it('the command prints the result and exits 0 on a pass, 1 for the agent, 2 on a usage error', async (t) => {
    const b = bed(t, { types: OK });
    const run = (arg) => spawnSync(process.execPath, [script('gatesrun.mjs'), arg], { encoding: 'utf8' });
    const ok = run(JSON.stringify(b.input));
    assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).status, 'pass');
    assert.equal(run('{}').status, 2);
  });

  it('renderTable counts hook rows as passed and says so', () => {
    const t = renderTable('shop', [{ gate: 'Types', status: 'PASS' }, { gate: 'Lint', status: 'HOOK', notes: 'pre-commit · eslint' }], { reused: '2026-10-16T10:00Z' });
    assert.match(t, /\| Lint \| HOOK \| pre-commit · eslint \|/);
    assert.match(t, /1 gate enforced by the repo's hooks/); assert.match(t, /reused — recorded 2026-10-16T10:00Z/);
    void readFileSync;
  });
});
