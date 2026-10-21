// worktree.mjs — a ticket's worktree made, re-branched and removed by the script, on real git repositories with a bare remote.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, script, writeJson } from './helpers.mjs';
import { add, rebranch, remove, finish, installCommand } from '../lib/worktree.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare remote, a clone of it with main pushed, and a .claude that turns the install off (no network in a test). */
function bed(t, tiers = { worktree: { install: null } }) {
  const root = tmp('worktree-'); t.after(() => rm(root));
  const bare = join(root, 'remote.git'); mkdirSync(bare); git(bare, 'init', '-q', '--bare', '-b', 'main');
  const repo = join(root, 'shop'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'remote', 'add', 'origin', bare);
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  const claudeDir = join(root, '.claude'); mkdirSync(join(claudeDir, 'work'), { recursive: true }); writeJson(claudeDir, 'tiers.json', tiers);
  return { root, repo, claudeDir, base: { repo, id: 'T-1', base: 'main', branch: 'feat/x', claudeDir } };
}

describe('worktree add', () => {
  it('creates the worktree on a new branch off the remote base and returns the row with absolute paths', (t) => {
    const b = bed(t);
    const r = add(b.base);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.deepEqual(r.row, { name: 'shop', path: b.repo, worktree: join(b.claudeDir, 'worktrees', 'T-1', 'shop'), branch: 'feat/x', base: 'main' });
    assert.ok(existsSync(join(r.row.worktree, 'a.txt')));
    assert.equal(git(r.row.worktree, 'branch', '--show-current'), 'feat/x');
  });

  it('a branch name somebody has taken, locally or on the remote, gets a suffix', (t) => {
    const b = bed(t);
    git(b.repo, 'branch', 'feat/x');
    assert.equal(add(b.base).row.branch, 'feat/x-2');
    const c = bed(t);
    git(c.repo, 'checkout', '-q', '-b', 'feat/x'); git(c.repo, 'push', '-q', 'origin', 'feat/x'); git(c.repo, 'checkout', '-q', 'main'); git(c.repo, 'branch', '-D', 'feat/x');
    assert.equal(add(c.base).row.branch, 'feat/x-2');
  });

  it('a dependent ticket branches off the open branch; a stacked one reuses the sibling\'s worktree', (t) => {
    const b = bed(t);
    git(b.repo, 'checkout', '-q', '-b', 'feat/open'); writeFileSync(join(b.repo, 'o.txt'), 'o\n'); git(b.repo, 'add', '.'); git(b.repo, 'commit', '-q', '-m', 'open'); git(b.repo, 'push', '-q', 'origin', 'feat/open'); git(b.repo, 'checkout', '-q', 'main');
    const dep = add({ ...b.base, id: 'T-2', from: 'feat/open', branch: 'feat/dep' });
    assert.equal(dep.status, 'ok'); assert.ok(existsSync(join(dep.row.worktree, 'o.txt')));
    const sib = add({ ...b.base, id: 'T-3', from: 'feat/open', stack: true, branch: 'unused' });
    assert.equal(sib.status, 'ok'); assert.equal(sib.row.branch, 'feat/open');
    const again = add({ ...b.base, id: 'T-4', from: 'feat/open', stack: true, branch: 'unused' });
    assert.equal(again.reused, true); assert.equal(realpathSync(again.row.worktree), realpathSync(sib.row.worktree));
  });

  it('a branch checked out in the person\'s own copy is a block, not an error', (t) => {
    const b = bed(t);
    git(b.repo, 'checkout', '-q', '-b', 'feat/open'); git(b.repo, 'push', '-q', 'origin', 'feat/open');
    const r = add({ ...b.base, id: 'T-9', from: 'feat/open', stack: true, branch: 'x' });
    assert.equal(r.status, 'blocked'); assert.match(r.why, /feat\/open is checked out elsewhere/);
  });

  it('fetch failures and a failing install are errors that name the cause', (t) => {
    const b = bed(t);
    git(b.repo, 'remote', 'set-url', 'origin', join(b.root, 'nowhere.git'));
    assert.match(add(b.base).error, /fetch of origin\/main failed/);
    const c = bed(t, { worktree: { install: 'node -e "process.exit(4)"' } });
    const r = add(c.base);
    assert.equal(r.status, 'error'); assert.match(r.error, /install failed \(node -e "process\.exit\(4\)", exit 4\)/);
    assert.equal(r.install.exit, 4);
  });

  it('an install that stops on an unset variable it does not use runs once more with a placeholder, and says so', (t) => {
    // the stand-in for `prisma generate`: fails with Prisma's message unless the variable is set
    const script = `if(!process.env.TP_TEST_DB){console.error('Cannot resolve environment variable: TP_TEST_DB.');process.exit(1)}`;
    const c = bed(t, { worktree: { install: `node -e "${script}"` } });
    delete process.env.TP_TEST_DB;
    const r = add(c.base);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(r.install.exit, 0); assert.equal(r.install.retry.env, 'TP_TEST_DB');
    assert.equal(process.env.TP_TEST_DB, undefined, 'the placeholder never leaks into this process');
    const d = bed(t, { worktree: { install: `node -e "console.error('Cannot resolve environment variable: TP_TEST_DB.');process.exit(1)"` } });
    const bad = add(d.base);
    assert.equal(bad.status, 'error', 'a failure the placeholder does not cure is still an error'); assert.equal(bad.install.retry.env, 'TP_TEST_DB');
  });

  it('installCommand follows the lockfile unless tiers.json says otherwise', (t) => {
    const b = bed(t, {});
    assert.equal(installCommand(b.repo, b.claudeDir), null);
    writeFileSync(join(b.repo, 'pnpm-lock.yaml'), ''); assert.equal(installCommand(b.repo, b.claudeDir), 'pnpm install --frozen-lockfile');
    writeFileSync(join(b.repo, 'package-lock.json'), ''); assert.equal(installCommand(b.repo, b.claudeDir), 'npm ci', 'the first lockfile on the list wins');
    writeJson(b.claudeDir, 'tiers.json', { worktree: { install: 'make deps' } }); assert.equal(installCommand(b.repo, b.claudeDir), 'make deps');
  });
});

describe('worktree rebranch and remove', () => {
  it('a new round puts the same worktree on a new branch off the updated base', (t) => {
    const b = bed(t);
    const r0 = add(b.base);
    git(b.repo, 'checkout', '-q', 'main'); writeFileSync(join(b.repo, 'm.txt'), 'm\n'); git(b.repo, 'add', '.'); git(b.repo, 'commit', '-q', '-m', 'merged work'); git(b.repo, 'push', '-q', 'origin', 'main');
    const r = rebranch({ worktree: r0.row.worktree, base: 'main', branch: 'feat/x-r2', claudeDir: b.claudeDir });
    assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.branch, 'feat/x-r2'); assert.equal(r.installed, false);
    assert.ok(existsSync(join(r0.row.worktree, 'm.txt')));
  });

  it('remove takes the worktree and a branch that was never pushed, keeps a sibling\'s, and --dry only plans', (t) => {
    const b = bed(t);
    const r0 = add(b.base);
    const plan = remove({ repo: b.repo, id: 'T-1', branch: 'feat/x', claudeDir: b.claudeDir, dry: true });
    assert.equal(plan.plan.length, 2); assert.ok(existsSync(r0.row.worktree));
    mkdirSync(join(b.claudeDir, 'work', 'T-2'), { recursive: true });
    writeJson(join(b.claudeDir, 'work', 'T-2'), 'ticket.json', { id: 'T-2', repos: [{ name: 'shop', worktree: r0.row.worktree }] });
    assert.match(remove({ repo: b.repo, id: 'T-1', claudeDir: b.claudeDir }).kept[0], /ticket T-2 still names it/);
    rm(join(b.claudeDir, 'work', 'T-2'));
    const done = remove({ repo: b.repo, id: 'T-1', branch: 'feat/x', claudeDir: b.claudeDir });
    assert.deepEqual(done.removed, [r0.row.worktree, 'branch feat/x']);
    assert.ok(!existsSync(r0.row.worktree)); assert.ok(!existsSync(join(b.claudeDir, 'worktrees', 'T-1')));
  });

  it('a pushed, unmerged branch stays; the command prints JSON and exits by status', (t) => {
    const b = bed(t);
    const r0 = add(b.base);
    writeFileSync(join(r0.row.worktree, 'w.txt'), 'w\n'); git(r0.row.worktree, 'add', '.'); git(r0.row.worktree, 'commit', '-q', '-m', 'work'); git(r0.row.worktree, 'push', '-q', 'origin', 'feat/x');
    const done = remove({ repo: b.repo, id: 'T-1', branch: 'feat/x', claudeDir: b.claudeDir });
    assert.match(done.kept.join(), /branch feat\/x \(pushed and not merged\)/);
    const run = (cmd, arg) => spawnSync(process.execPath, [script('worktree.mjs'), cmd, arg], { encoding: 'utf8' });
    assert.equal(run('add', '{}').status, 2);
    assert.equal(run('nonsense', '{}').status, 2);
    void readFileSync;
  });
});

describe('worktree finish — the end of a ticket, held while the person has manual steps', () => {
  const ticketWith = (b, manual) => {
    const r = add(b.base); assert.equal(r.status, 'ok', JSON.stringify(r));
    const workdir = join(b.claudeDir, 'work', 'T-1'); mkdirSync(workdir, { recursive: true });
    writeJson(workdir, 'ticket.json', { id: 'T-1', repos: [r.row] });
    writeFileSync(join(workdir, 'progress.md'), '- 2026-10-19T09:00Z · start-ticket · done · picked up · x\n- 2026-10-19T10:00Z · accept · done · 1 pass - ' + manual + ' manual\n');
    writeJson(workdir, 'accept.json', { passed: 1, failed: 0, manual });
    return { workdir, row: r.row };
  };

  it('keeps every worktree and branch while acceptance left manual criteria; a recorded confirmation ends the hold', (t) => {
    const b = bed(t);
    const { workdir, row } = ticketWith(b, 2);
    const held = finish({ workdir });
    assert.equal(held.status, 'held'); assert.equal(held.manualOpen, 2); assert.match(held.why, /answers=confirmed/);
    assert.ok(existsSync(row.worktree), 'nothing removed');
    writeFileSync(join(workdir, 'progress.md'), readFileSync(join(workdir, 'progress.md'), 'utf8') + '- 2026-10-19T11:00Z · accept · note · manual confirmed\n');
    const done = finish({ workdir });
    assert.equal(done.status, 'ok', JSON.stringify(done));
    assert.ok(!existsSync(row.worktree), 'the checkout is gone once confirmed');
    assert.ok(done.repos[0].removed.some((x) => x.startsWith('branch ')), 'and the merged branch with it');
  });

  it('with no manual criteria it removes at once; dry lists the plan only; a missing ticket.json is an error', (t) => {
    const b = bed(t);
    const { workdir, row } = ticketWith(b, 0);
    const dry = finish({ workdir, dry: true });
    assert.equal(dry.status, 'ok'); assert.ok(existsSync(row.worktree)); assert.match(dry.repos[0].plan.join('\n'), /worktree remove/);
    assert.equal(finish({ workdir }).status, 'ok'); assert.ok(!existsSync(row.worktree));
    assert.equal(finish({ workdir: join(b.claudeDir, 'work', 'none') }).status, 'error');
    assert.equal(finish({}).status, 'error');
  });

  it('is a command: exit 1 while held', (t) => {
    const b = bed(t);
    const { workdir } = ticketWith(b, 1);
    const r = spawnSync(process.execPath, [script('worktree.mjs'), 'finish', JSON.stringify({ workdir })], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).status, 'held');
  });
});
