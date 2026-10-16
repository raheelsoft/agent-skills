// branchfacts.mjs — the git facts a stage asks for before it acts, in one call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, script } from './helpers.mjs';
import { branchfacts } from '../lib/branchfacts.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, body, msg) => { writeFileSync(join(repo, file), body); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };

/** A bare remote with main, a clone of it on a feature branch one commit ahead. */
function bed(t) {
  const root = tmp('branchfacts-'); t.after(() => rm(root));
  const bare = join(root, 'remote.git'); mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const repo = join(root, 'shop'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'remote', 'add', 'origin', bare);
  commit(repo, 'a.txt', 'a\n', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  commit(repo, 'b.txt', 'one\ntwo\n', 'add b');
  return { root, bare, repo };
}

describe('branchfacts', () => {
  it('reports the branch, its commits, the diff size and that it is not pushed yet', (t) => {
    const { repo } = bed(t);
    writeFileSync(join(repo, 'wip.txt'), 'x\n');
    writeFileSync(join(repo, 'b.txt'), 'edited\n');
    const f = branchfacts({ repo, base: 'main' });
    assert.equal(f.branch, 'feat/x'); assert.equal(f.onBase, false);
    assert.equal(f.base.ref, 'origin/main'); assert.equal(f.ahead, 1); assert.equal(f.behind, 0);
    assert.deepEqual(f.commits.map((c) => c.subject), ['add b']);
    assert.deepEqual(f.diff, { files: 1, additions: 2, deletions: 0 });
    assert.deepEqual(f.dirty, [{ status: 'M', path: 'b.txt' }, { status: '??', path: 'wip.txt' }]);
    assert.equal(f.remote.name, 'origin'); assert.deepEqual(f.pushed, { exists: false, sha: null, upToDate: false });
  });

  it('sees a pushed branch as up to date, and a base that moved on as behind (after a fetch)', (t) => {
    const { root, repo } = bed(t);
    git(repo, 'push', '-q', '-u', 'origin', 'feat/x');
    assert.equal(branchfacts({ repo, base: 'origin/main' }).pushed.upToDate, true);
    const other = join(root, 'other'); git(root, 'clone', '-q', join(root, 'remote.git'), other);
    commit(other, 'c.txt', 'c\n', 'upstream work'); git(other, 'push', '-q', 'origin', 'main');
    assert.equal(branchfacts({ repo, base: 'main' }).behind, 0, 'not fetched yet: the last known remote state');
    const f = branchfacts({ repo, base: 'main', fetch: true });
    assert.deepEqual(f.fetch, { ok: true }); assert.equal(f.behind, 1); assert.equal(f.ahead, 1);
  });

  it('on the base branch it says so, and an unknown base or a non-repo is an error', (t) => {
    const { root, repo } = bed(t);
    git(repo, 'checkout', '-q', 'main');
    assert.equal(branchfacts({ repo, base: 'main' }).onBase, true);
    assert.throws(() => branchfacts({ repo, base: 'nope' }), /not a branch/);
    assert.throws(() => branchfacts({ repo: root, base: 'main' }), /not a git checkout/);
  });

  it('the command prints the JSON; a missing field is a usage error', (t) => {
    const { repo } = bed(t);
    const ok = spawnSync(process.execPath, [script('branchfacts.mjs'), JSON.stringify({ repo, base: 'main' })], { encoding: 'utf8' });
    assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).branch, 'feat/x');
    const bad = spawnSync(process.execPath, [script('branchfacts.mjs'), '{}'], { encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /usage: branchfacts\.mjs/);
  });
});
