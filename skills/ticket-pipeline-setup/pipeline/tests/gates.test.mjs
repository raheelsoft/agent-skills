// gates.mjs — the gate baseline (one persistent checkout per repo, outputs cached per base commit) and the gate record
// (a verify result per head/base pair, reused by every later stage): skills/README.md § Verification rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, CLAUDE_DIR, writeJson } from './helpers.mjs';

const GATES = join(CLAUDE_DIR, 'skills', '_lib', 'gates.mjs');

function gates(...args) {
  const r = spawnSync(process.execPath, [GATES, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* normalise prints lines */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** A repo with a bare remote `origin`, one commit on main (with a package-lock.json), and a ticket worktree on feat/t. */
function bed(root) {
  const claude = join(root, '.claude');
  mkdirSync(join(claude, 'work'), { recursive: true });
  const remote = join(root, 'api.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, 'api');
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  const git = (args, cwd = repo) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['checkout', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'package-lock.json'), '{}\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  git(['push', '-q', '-u', 'origin', 'main']);
  const wt = join(claude, 'work', 'T-1', 'wt', 'api');
  mkdirSync(join(claude, 'work', 'T-1'), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'feat/t', wt, 'origin/main']);
  return { claude, remote, repo, wt, git, sha: () => git(['rev-parse', 'origin/main']) };
}

describe('gates.mjs base — one baseline checkout per repo', () => {
  it('creates the detached baseline at the base head once, then only moves it when the base advances', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    const first = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.checkout, join(b.claude, 'work', '_scratch', 'wt', 'base-api'));
    assert.equal(first.json.sha, b.sha());
    assert.equal(first.json.created, true);
    assert.deepEqual(first.json.lockfilesChanged, ['package-lock.json'], 'a new checkout needs an install');
    assert.equal(execFileSync('git', ['-C', first.json.checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), first.json.sha);
    gates('release', { repo: b.repo, claudeDir: b.claude });

    const again = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.created, false);
    assert.equal(again.json.moved, false);
    assert.deepEqual(again.json.lockfilesChanged, [], 'nothing to install when the base stood still');
    gates('release', { repo: b.repo, claudeDir: b.claude });

    // the base advances without touching a lockfile → moved, no install
    writeFileSync(join(b.repo, 'b.ts'), 'export const b = 2;\n');
    b.git(['add', '.']); b.git(['commit', '-q', '-m', 'b']); b.git(['push', '-q', 'origin', 'main']);
    const moved = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.equal(moved.code, 0, moved.stderr);
    assert.equal(moved.json.moved, true);
    assert.equal(moved.json.previous, first.json.sha);
    assert.equal(moved.json.sha, b.sha());
    assert.deepEqual(moved.json.lockfilesChanged, []);
    gates('release', { repo: b.repo, claudeDir: b.claude });

    // … and with a lockfile change → the caller installs again
    writeFileSync(join(b.repo, 'package-lock.json'), '{ "v": 2 }\n');
    b.git(['add', '.']); b.git(['commit', '-q', '-m', 'deps']); b.git(['push', '-q', 'origin', 'main']);
    const deps = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.deepEqual(deps.json.lockfilesChanged, ['package-lock.json']);
    gates('release', { repo: b.repo, claudeDir: b.claude });
  });

  it('resets a baseline a run left dirty — it is the pipeline\'s own checkout', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    const first = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    gates('release', { repo: b.repo, claudeDir: b.claude });
    writeFileSync(join(first.json.checkout, 'a.ts'), 'changed\n');
    writeFileSync(join(first.json.checkout, 'stray.txt'), 'x\n');
    const again = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(execFileSync('git', ['-C', first.json.checkout, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
    assert.equal(readFileSync(join(first.json.checkout, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  });

  it('is held by one verify at a time: exit 3 while locked, free after release, taken over when stale', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    assert.equal(gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude }).code, 0);
    const held = gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude });
    assert.equal(held.code, 3);
    assert.equal(held.json.error, 'held');
    assert.ok(held.json.since);
    assert.equal(gates('release', { repo: b.repo, claudeDir: b.claude }).code, 0);
    assert.equal(gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude }).code, 0, 'free after release');
    // stale: an old stamp is taken over
    const stamp = join(b.claude, 'work', '_scratch', 'gates', 'api', 'base.lock', 'at');
    writeFileSync(stamp, new Date(Date.now() - 45 * 60000).toISOString() + '\n');
    assert.equal(gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude }).code, 0, 'a stale lock is taken over');
    // tiers.json tunes the staleness
    writeJson(b.claude, 'tiers.json', { gates: { lockMinutes: 90 } });
    writeFileSync(stamp, new Date(Date.now() - 45 * 60000).toISOString() + '\n');
    assert.equal(gates('base', { repo: b.repo, base: 'main', claudeDir: b.claude }).code, 3, '45 minutes is fresh when the limit is 90');
  });

  it('refuses without repo, base or claudeDir', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    assert.equal(gates('base', { repo: b.repo, claudeDir: b.claude }).code, 1);
    assert.equal(gates('base', { base: 'main', claudeDir: b.claude }).code, 1);
    assert.equal(gates('nonsense').code, 2);
  });
});

describe('gates.mjs normalise / new — outputs compare as sets of findings', () => {
  it('strips ANSI, positions, stamps, durations and the checkouts\' paths, and sorts unique lines', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const f = join(root, 'out.txt');
    writeFileSync(f, [
      '\x1b[31msrc/a.ts(12,5): error TS2322: bad\x1b[0m',
      '/wt/api/src/b.ts:3:14 - error TS1005: worse',
      '/wt/api/src/b.ts:3:14 - error TS1005: worse',
      '  12:5  error  Missing semicolon  semi',
      'Done in 3.2s at 2026-09-20T10:11:12Z',
      '',
      'Found 2 errors in 1 file.',
    ].join('\n'));
    const r = gates('normalise', { file: f, roots: ['/wt/api'] });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'Done in at',
      'Found 2 errors in 1 file.',
      'error Missing semicolon semi',
      'src/a.ts: error TS2322: bad',
      'src/b.ts - error TS1005: worse',
    ]);
  });

  it('reports only the head\'s new lines, whatever checkout each output came from', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    const baseOut = join(root, 'base.txt'), headOut = join(root, 'head.txt');
    const baseline = join(b.claude, 'work', '_scratch', 'wt', 'base-api');
    writeFileSync(baseOut, `${baseline}/src/old.ts(1,1): error TS1 old\n`);
    writeFileSync(headOut, `${b.wt}/src/old.ts(9,9): error TS1 old\n${b.wt}/src/new.ts(2,2): error TS2 new\n`);
    const r = gates('new', { repo: b.repo, baseFile: baseOut, headFile: headOut, checkout: b.wt, claudeDir: b.claude });
    assert.equal(r.code, 1, 'new lines → exit 1');
    assert.deepEqual(r.json.new, ['src/new.ts: error TS2 new']);
    writeFileSync(headOut, `${b.wt}/src/old.ts(9,9): error TS1 old\n`);
    const same = gates('new', { repo: b.repo, baseFile: baseOut, headFile: headOut, checkout: b.wt, claudeDir: b.claude });
    assert.equal(same.code, 0);
    assert.deepEqual(same.json.new, []);
  });
});

describe('gates.mjs cache — the base\'s output once per base commit', () => {
  it('misses, stores the normalised output, hits for the same command, misses for another', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    const sha = b.sha();
    const miss = gates('cache', 'get', { repo: b.repo, sha, gate: 'types', claudeDir: b.claude });
    assert.equal(miss.code, 1);
    assert.equal(miss.json.miss, true);
    const out = join(root, 'tsc.txt');
    writeFileSync(out, `${join(b.claude, 'work', '_scratch', 'wt', 'base-api')}/src/a.ts(1,1): error TS9 x\n`);
    const put = gates('cache', 'put', { repo: b.repo, sha, gate: 'types', command: 'npm run typecheck', file: out, claudeDir: b.claude });
    assert.equal(put.code, 0, put.stderr);
    assert.equal(put.json.lines, 1);
    assert.equal(readFileSync(put.json.file, 'utf8'), 'src/a.ts: error TS9 x\n');
    const hit = gates('cache', 'get', { repo: b.repo, sha, gate: 'types', command: 'npm run typecheck', claudeDir: b.claude });
    assert.equal(hit.code, 0);
    assert.equal(hit.json.file, put.json.file);
    assert.equal(hit.json.command, 'npm run typecheck');
    assert.equal(gates('cache', 'get', { repo: b.repo, sha, gate: 'types', command: 'tsc -p other', claudeDir: b.claude }).code, 1, 'another command is a miss');
    assert.equal(gates('cache', 'get', { repo: b.repo, sha, gate: 'types', claudeDir: b.claude }).code, 0, 'no command asked → the gate name is enough');
    assert.equal(gates('cache', 'get', { repo: b.repo, sha: 'nope', gate: 'types', claudeDir: b.claude }).code, 1, 'a sha must be a hash');
  });

  it('keeps only the newest commits\' outputs (tiers.json.gates.keepBases)', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    writeJson(b.claude, 'tiers.json', { gates: { keepBases: 2 } });
    const out = join(root, 'o.txt'); writeFileSync(out, 'x\n');
    const shas = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    for (const [i, sha] of shas.entries()) {
      gates('cache', 'put', { repo: b.repo, sha, gate: 'build', file: out, claudeDir: b.claude });
      const d = join(b.claude, 'work', '_scratch', 'gates', 'api', sha);
      const when = new Date(Date.now() - (shas.length - i) * 60000);
      utimesSync(d, when, when);
    }
    gates('cache', 'put', { repo: b.repo, sha: 'd'.repeat(40), gate: 'build', file: out, claudeDir: b.claude });
    const kept = readdirSync(join(b.claude, 'work', '_scratch', 'gates', 'api')).filter((n) => /^[a-f]{40}$/.test(n)).sort();
    assert.deepEqual(kept, ['c'.repeat(40), 'd'.repeat(40)]);
  });
});

describe('gates.mjs result — a verify result per head and base, reused when the checkout still matches', () => {
  it('records a clean checkout\'s result and hands it back for the same commits; refuses a dirty or moved checkout', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const b = bed(root);
    const head = b.git(['rev-parse', 'HEAD'], b.wt);
    const base = b.sha();
    const none = gates('result', 'get', { repo: b.repo, head, base, checkout: b.wt, claudeDir: b.claude });
    assert.equal(none.code, 1);
    const table = '| Gate | Status |\n| Types | PASS |\n';
    const put = gates('result', 'put', { repo: b.repo, head, base, verdict: 'ALL GATES PASSED', table, gates: { types: 'PASS' }, checkout: b.wt, claudeDir: b.claude });
    assert.equal(put.code, 0, put.stderr);
    assert.equal(put.json.verdict, 'ALL GATES PASSED');
    assert.ok(existsSync(join(b.claude, 'work', '_scratch', 'gates', 'api', 'results', `${head}.${base}.json`)));
    const hit = gates('result', 'get', { repo: b.repo, head, base, checkout: b.wt, claudeDir: b.claude });
    assert.equal(hit.code, 0);
    assert.equal(hit.json.table, table);
    assert.deepEqual(hit.json.gates, { types: 'PASS' });
    // without a checkout the record is handed back as a fact about the commits
    assert.equal(gates('result', 'get', { repo: b.repo, head, base, claudeDir: b.claude }).code, 0);
    // a dirty checkout: the record does not apply to what is on disk
    writeFileSync(join(b.wt, 'a.ts'), 'export const a = 2;\n');
    const dirty = gates('result', 'get', { repo: b.repo, head, base, checkout: b.wt, claudeDir: b.claude });
    assert.equal(dirty.code, 2);
    assert.match(dirty.json.error, /uncommitted/);
    assert.equal(gates('result', 'put', { repo: b.repo, head, base, verdict: 'x', table: 'y', checkout: b.wt, claudeDir: b.claude }).code, 2, 'nothing is recorded from a dirty checkout');
    // a new commit: another head, no record
    b.git(['add', '.'], b.wt); b.git(['commit', '-q', '-m', 'more'], b.wt);
    const head2 = b.git(['rev-parse', 'HEAD'], b.wt);
    assert.equal(gates('result', 'get', { repo: b.repo, head: head2, base, checkout: b.wt, claudeDir: b.claude }).code, 1);
    const moved = gates('result', 'get', { repo: b.repo, head, base, checkout: b.wt, claudeDir: b.claude });
    assert.equal(moved.code, 2, 'the old head\'s record does not apply to a checkout that moved on');
    assert.match(moved.json.error, /not/);
  });
});
