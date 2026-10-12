// hosting.mjs — the file-backed hosting platform: pull requests over the repos' own remotes, with gh's verbs and field names. What makes it worth
// trusting is that a pull request stays real git: the head branch has to be on the remote, the diff is a diff, a merge is a commit in the remote.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, writeJson, script } from './helpers.mjs';

const HOSTING = script('hosting.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

/** A bare remote with main, a working clone, and a fixture pointing at it from a fake <.claude>. */
function bed(t, repos = ['api']) {
  const root = tmp('hosting-'); t.after(() => rm(root));
  const claude = join(root, '.claude'); mkdirSync(claude, { recursive: true });
  const fixture = { me: 'dev', repos: {} };
  const out = { root, claude };
  for (const name of repos) {
    const remote = join(root, `${name}.git`); const clone = join(root, name);
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, clone);
    writeFileSync(join(clone, 'app.js'), 'export const a = 1;\nexport const b = 2;\n');
    git(clone, 'add', '.'); git(clone, 'commit', '-q', '-m', 'init'); git(clone, 'push', '-q', 'origin', 'HEAD:main');
    fixture.repos[name] = { remote, defaultBranch: 'main' };
    out[name] = { remote, clone };
  }
  writeJson(root, 'hosting.fixture.json', fixture);
  writeJson(claude, 'hosting.json', { kind: 'fixture', path: join(root, 'hosting.fixture.json') });
  return out;
}
/** A branch with one commit, pushed. */
function branch(clone, name, file = 'feature.js', body = 'export const f = 1;\n') {
  git(clone, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(join(clone, file), body);
  git(clone, 'add', '.'); git(clone, 'commit', '-q', '-m', `add ${file}`); git(clone, 'push', '-q', 'origin', name);
  git(clone, 'checkout', '-q', 'main');
}
function run(b, cwd, input, args) {
  const r = spawnSync(process.execPath, [HOSTING, ...args, '--claude', b.claude], { cwd, encoding: 'utf8', input });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const host = (b, cwd, ...args) => run(b, cwd, undefined, args);
const hostIn = (b, cwd, input, ...args) => run(b, cwd, input, args);
const create = (b, repo = 'api', head = 'feat/x', title = 'Add the feature') => host(b, b[repo].clone, 'pr', 'create', '--head', head, '--title', title, '--body', 'the description');

describe('hosting.mjs — a pull request is real git', () => {
  it('knows who the person is and which repos it holds', (t) => {
    const b = bed(t, ['api', 'web']);
    assert.deepEqual(host(b, b.root, 'me').json, { me: 'dev', repos: ['api', 'web'] });
  });

  it('opens a pull request for a branch that is on the remote, from the repo the command runs in', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x');
    const r = create(b);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json, { number: 1, url: 'fixture://api/pull/1' });
    const v = host(b, b.api.clone, 'pr', 'view', '1', '--json', 'number,state,title,body,baseRefName,headRefName,headRefOid,mergeable,changedFiles');
    assert.deepEqual(v.json, { number: 1, state: 'OPEN', title: 'Add the feature', body: 'the description', baseRefName: 'main', headRefName: 'feat/x', headRefOid: git(b.api.remote, 'rev-parse', 'refs/heads/feat/x'), mergeable: 'MERGEABLE', changedFiles: 1 });
    assert.equal(host(b, b.api.clone, 'pr', 'view', 'fixture://api/pull/1', '--json', 'number').json.number, 1, 'by its url too');
  });

  it('refuses a branch that is not on the remote, the same branch twice, a head that is the base, and a missing title or body', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x');
    assert.match(host(b, b.api.clone, 'pr', 'create', '--head', 'feat/unpushed', '--title', 't', '--body', 'b').err, /not on the remote of api — push it first/);
    assert.equal(create(b).code, 0);
    assert.match(create(b).err, /already exists: fixture:\/\/api\/pull\/1/);
    assert.match(host(b, b.api.clone, 'pr', 'create', '--head', 'main', '--title', 't', '--body', 'b').err, /same branch/);
    assert.match(host(b, b.api.clone, 'pr', 'create', '--head', 'feat/x', '--body', 'b').err, /needs --title/);
    assert.match(host(b, b.api.clone, 'pr', 'create', '--head', 'feat/x', '--title', 't').err, /needs --body/);
  });

  it('lists by branch and state, with the fields gh lists, and refuses a field it does not have', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x'); branch(b.api.clone, 'feat/y', 'other.js');
    create(b); create(b, 'api', 'feat/y', 'Other');
    const l = host(b, b.api.clone, 'pr', 'list', '--head', 'feat/y');
    assert.deepEqual(l.json.map((p) => [p.number, p.title, p.state]), [[2, 'Other', 'OPEN']]);
    assert.equal(host(b, b.api.clone, 'pr', 'list').json.length, 2);
    assert.equal(host(b, b.api.clone, 'pr', 'list', '--state', 'merged').json.length, 0);
    assert.match(host(b, b.api.clone, 'pr', 'view', '1', '--json', 'nope').err, /unknown field "nope"/);
    assert.match(host(b, b.api.clone, 'pr', 'view', '9').err, /no pull request #9 in api/);
  });

  it('comments (from a file or stdin), edits the description, and shows the diff the remote holds', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x'); create(b);
    assert.equal(host(b, b.api.clone, 'pr', 'comment', '1', '--body', 'first').json.comments, 1);
    const stdin = hostIn(b, b.api.clone, 'second from stdin\n', 'pr', 'comment', '1', '--body-file', '-');
    assert.equal(stdin.json.comments, 2);
    assert.equal(stdin.json.url, 'fixture://api/pull/1#comment-2');
    assert.deepEqual(host(b, b.api.clone, 'pr', 'view', '1', '--json', 'comments').json.comments.map((c) => c.body), ['first', 'second from stdin']);
    assert.match(host(b, b.api.clone, 'pr', 'comment', '1', '--body', '   ').err, /needs text/);
    const body = join(b.root, 'body.md'); writeFileSync(body, '# new\n');
    host(b, b.api.clone, 'pr', 'edit', '1', '--title', 'Renamed', '--body-file', body);
    const v = host(b, b.api.clone, 'pr', 'view', '1', '--json', 'title,body').json;
    assert.deepEqual([v.title, v.body], ['Renamed', '# new\n']);
    assert.equal(host(b, b.api.clone, 'pr', 'diff', '1', '--name-only').out.trim(), 'feature.js');
    assert.match(host(b, b.api.clone, 'pr', 'diff', '1').out, /\+export const f = 1;/);
  });

  it('merges with a merge commit by default: two parents in the remote\'s base, the commit recorded, the branch kept', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x'); create(b);
    const m = host(b, b.api.clone, 'pr', 'merge', '1');
    assert.equal(m.code, 0, m.err);
    assert.equal(m.json.state, 'MERGED');
    const tip = git(b.api.remote, 'rev-parse', 'refs/heads/main');
    assert.equal(m.json.mergeCommit, tip);
    assert.equal(git(b.api.remote, 'rev-list', '--parents', '-1', tip).split(' ').length, 3, 'a merge commit has two parents');
    assert.equal(git(b.api.remote, 'log', '-1', '--format=%s', tip), 'Merge pull request #1 from feat/x');
    const v = host(b, b.api.clone, 'pr', 'view', '1', '--json', 'state,mergeCommit,mergedAt,headRefOid').json;
    assert.deepEqual([v.state, v.mergeCommit.oid, v.headRefOid], ['MERGED', tip, git(b.api.remote, 'rev-parse', 'refs/heads/feat/x')]);
    assert.ok(v.mergedAt);
    assert.match(host(b, b.api.clone, 'pr', 'merge', '1').err, /is merged, not open/);
    assert.equal(host(b, b.api.clone, 'pr', 'comment', '1', '--body', 'late').code, 0, 'a merged pull request still takes a comment');
  });

  it('squashes into one commit, or rebases into a line, and removes the branch on request', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/s'); branch(b.api.clone, 'feat/r', 'r.js');
    create(b, 'api', 'feat/s', 'Squashed'); create(b, 'api', 'feat/r', 'Rebased');
    const s = host(b, b.api.clone, 'pr', 'merge', '1', '--squash', '--delete-branch');
    assert.equal(s.json.strategy, 'squash');
    assert.equal(git(b.api.remote, 'log', '-1', '--format=%s', 'refs/heads/main'), 'Squashed (#1)');
    assert.equal(git(b.api.remote, 'rev-list', '--parents', '-1', 'refs/heads/main').split(' ').length, 2, 'one parent');
    assert.equal(spawnSync('git', ['--git-dir', b.api.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/s']).status, 1, 'the branch is gone');
    const r = host(b, b.api.clone, 'pr', 'merge', '2', '--rebase');
    assert.equal(r.code, 0, r.err);
    assert.equal(git(b.api.remote, 'rev-list', '--parents', '-1', 'refs/heads/main').split(' ').length, 2, 'a line, no merge commit');
    assert.deepEqual(git(b.api.remote, 'ls-tree', '--name-only', 'refs/heads/main').split('\n').sort(), ['app.js', 'feature.js', 'r.js']);
  });

  it('reports a conflict, refuses to merge it, and leaves the remote\'s base where it was', (t) => {
    const b = bed(t);
    git(b.api.clone, 'checkout', '-q', '-b', 'feat/c', 'main');
    writeFileSync(join(b.api.clone, 'app.js'), 'export const a = 100;\nexport const b = 2;\n');
    git(b.api.clone, 'commit', '-q', '-am', 'c'); git(b.api.clone, 'push', '-q', 'origin', 'feat/c');
    git(b.api.clone, 'checkout', '-q', 'main');
    writeFileSync(join(b.api.clone, 'app.js'), 'export const a = 200;\nexport const b = 2;\n');
    git(b.api.clone, 'commit', '-q', '-am', 'm'); git(b.api.clone, 'push', '-q', 'origin', 'main');
    create(b, 'api', 'feat/c', 'Conflicts');
    assert.equal(host(b, b.api.clone, 'pr', 'view', '1', '--json', 'mergeable').json.mergeable, 'CONFLICTING');
    const before = git(b.api.remote, 'rev-parse', 'refs/heads/main');
    const m = host(b, b.api.clone, 'pr', 'merge', '1');
    assert.equal(m.code, 1);
    assert.match(m.err, /not mergeable/);
    assert.equal(git(b.api.remote, 'rev-parse', 'refs/heads/main'), before);
    assert.equal(host(b, b.api.clone, 'pr', 'view', '1', '--json', 'state').json.state, 'OPEN');
  });

  it('closes a pull request, which can then not be merged; reports no checks and no runs', (t) => {
    const b = bed(t); branch(b.api.clone, 'feat/x'); create(b);
    assert.deepEqual(host(b, b.api.clone, 'pr', 'checks', '1').json.checks, []);
    assert.deepEqual(host(b, b.api.clone, 'run', 'list').json, []);
    assert.equal(host(b, b.api.clone, 'pr', 'close', '1').json.state, 'CLOSED');
    assert.match(host(b, b.api.clone, 'pr', 'merge', '1').err, /is closed, not open/);
    assert.equal(create(b).code, 0, 'a new pull request for the branch may be opened once the old one is closed');
  });

  it('finds the repo from the checkout the command runs in, or --repo, and asks when it cannot tell', (t) => {
    const b = bed(t, ['api', 'web']); branch(b.api.clone, 'feat/x'); branch(b.web.clone, 'feat/w', 'w.js');
    assert.equal(create(b, 'api').json.url, 'fixture://api/pull/1');
    assert.equal(create(b, 'web', 'feat/w', 'Web').json.url, 'fixture://web/pull/1', 'numbers are per repo');
    assert.equal(host(b, b.root, 'pr', 'view', '1', '--repo', 'web', '--json', 'title').json.title, 'Web');
    assert.match(host(b, b.root, 'pr', 'view', '1').err, /which repo\?/);
    assert.match(host(b, b.root, 'pr', 'view', '1', '--repo', 'nope').err, /no repo "nope"/);
  });

  it('says what is wrong with the configuration instead of failing silently', (t) => {
    const b = bed(t);
    rm(join(b.claude, 'hosting.json'));
    assert.match(host(b, b.root, 'me').err, /hosting\.json missing — this install uses the connected platform's CLI/);
    writeJson(b.claude, 'hosting.json', { kind: 'real' });
    assert.match(host(b, b.root, 'me').err, /must be \{ "kind": "fixture"/);
    writeJson(b.claude, 'hosting.json', { kind: 'fixture', path: join(b.root, 'hosting.fixture.json') });
    assert.match(host(b, b.root, 'bogus').err, /usage:/);
    assert.equal(JSON.parse(readFileSync(join(b.root, 'hosting.fixture.json'), 'utf8')).prs, undefined, 'nothing was written by a failed call');
  });
});
