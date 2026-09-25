// doctor.mjs — the preflight, on throw-away installs with real git repos and bare remotes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, tmp, rm, writeJson, readJson, pickedUp, stampAgo } from './helpers.mjs';
import { CATALOGUE } from '../skills/_lib/setup.mjs';

const DOCTOR = join(CLAUDE_DIR, 'skills', '_lib', 'doctor.mjs');
function doctor(...args) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, json, stderr: r.stderr };
}
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const byName = (d, name) => d.checks.find((c) => c.name === name);

/** A pre-commit hook that runs the repo's own lint script — the gates the pipeline then never runs. */
function hooksFor(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg.scripts = { ...(pkg.scripts || {}), lint: 'eslint .' };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  mkdirSync(join(repo, '.husky'), { recursive: true });
  writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nnpm run lint\n');
  git(repo, ['config', 'core.hooksPath', '.husky']);
}

/** A repo with a bare origin holding `main`, at <root>/<name>. */
function repoWithRemote(root, name) {
  const bare = join(root, `${name}.git`); const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), name);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name }, null, 2));
  git(repo, ['add', '.']); git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  git(root, ['init', '-q', '--bare', bare]);
  git(repo, ['remote', 'add', 'origin', bare]); git(repo, ['push', '-q', 'origin', 'main']);
  return repo;
}
/** A throw-away <.claude>: every catalogue skill's folder (+ setup), tiers.json, settings with the Install rules, an empty work root. */
function install(root, tiers = {}) {
  const c = join(root, '.claude');
  for (const name of [...Object.keys(CATALOGUE), 'tp-setup']) { mkdirSync(join(c, 'skills', name), { recursive: true }); writeFileSync(join(c, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`); }
  mkdirSync(join(c, 'work'), { recursive: true });
  writeJson(c, 'tiers.json', { low: 'a', medium: 'b', high: 'c', prices: { low: 1, medium: 2, high: 3 }, ...tiers });
  writeJson(c, 'notify.json', { tool: 'chat', target: '#dev', project: 'p', levels: ['stop'], setAt: 'x' });
  writeJson(c, 'settings.local.json', { permissions: { allow: [`Bash(node ${c}/skills/_lib/*)`, `Bash(node ${c}/office/*)`, 'Bash(node --test *)', 'Bash(git *)'] } });
  return c;
}

describe('doctor.mjs', () => {
  let root, c, api, web;
  before(() => { root = tmp('doctor-'); c = install(root, { doctor: { checks: [{ name: 'echo check', run: ['echo', 'hello'], expect: 'hello' }] } }); api = repoWithRemote(root, 'api'); web = repoWithRemote(root, 'web'); });
  after(() => rm(root));

  it('passes a healthy install: toolchain, files, repos with a reachable remote and base, the configured check, the allowlist', () => {
    for (const p of [api, web]) hooksFor(p); // gate hooks: a repo without them is a warning of its own (below)
    const r = doctor('run', c, '--repos', `${api},${web}`);
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json?.checks));
    const d = r.json;
    assert.equal(d.ok, true);
    for (const n of ['node', 'git', 'tiers.json', 'notify', 'work', 'scripts', 'repo api', 'repo web', 'echo check', 'allowlist', 'skills', 'hooks api', 'hooks web']) assert.equal(byName(d, n)?.status, 'ok', n);
    assert.match(byName(d, 'hooks api').detail, /lint.*enforced by pre-commit/);
    assert.match(byName(d, 'repo api').detail, /api\.git · base main/);
    assert.ok(!d.checks.some((x) => x.status === 'fail' || x.status === 'warn'), JSON.stringify(d.checks.filter((x) => x.status !== 'ok')));
    assert.ok(existsSync(join(c, 'work', '_doctor.json')));
    assert.equal(readJson(join(c, 'work'), '_doctor.json').at, d.at);
  });

  it('flags a base branch missing on the remote, an unreachable remote, a stray file, a stale lock, a bad tiers.json, missing allowlist rules, a failing check', () => {
    const r2 = tmp('doctor-'); const c2 = install(r2, { doctor: { checks: [{ name: 'auth', run: ['false'] }] } });
    const repo = repoWithRemote(r2, 'svc');
    // a ticket recorded a base the remote does not have; another names a repo whose remote is gone
    const t = pickedUp(c2, { id: 'T-1', repos: [{ name: 'svc', path: repo, branch: 'feat/x' }] });
    const tj = readJson(t, 'ticket.json'); tj.repos[0].base = 'develop'; writeJson(t, 'ticket.json', tj);
    const gone = repoWithRemote(r2, 'gone'); rm(join(r2, 'gone.git'));
    writeFileSync(join(c2, 'work', 'progress.md'), '- stray\n');
    const old = stampAgo(7 * 3600000);
    writeJson(t, 'lock.json', { owner: 'ghost', since: old, updated: old });
    writeJson(c2, 'settings.local.json', { permissions: { allow: ['Bash(git status*)'] } });
    let r = doctor('run', c2, '--repos', `${repo},${gone}`);
    assert.equal(r.code, 2);
    const d = r.json;
    assert.equal(d.ok, false);
    assert.match(byName(d, 'repo svc').detail, /no branch "develop"/); assert.equal(byName(d, 'repo svc').status, 'fail');
    assert.equal(byName(d, 'repo gone').status, 'fail'); assert.match(byName(d, 'repo gone').detail, /unreachable/);
    assert.match(byName(d, 'work root').detail, /progress\.md/); assert.equal(byName(d, 'work root').status, 'warn');
    assert.match(byName(d, 'locks').fix, /unlock .*T-1 ghost/);
    assert.equal(byName(d, 'auth').status, 'fail');
    assert.match(byName(d, 'allowlist').detail, /of the Install rules missing/);
    // the tiers file itself
    writeFileSync(join(c2, 'tiers.json'), '{ nope');
    r = doctor('run', c2, '--repos', repo);
    assert.equal(byName(r.json, 'tiers.json').status, 'fail');
    writeJson(c2, 'tiers.json', { low: 'a', medium: 'b', budget: { economy: 95, stop: 90 } });
    r = doctor('run', c2, '--repos', repo);
    assert.match(byName(r.json, 'tiers.json').detail, /no model for high/);
    assert.equal(byName(r.json, 'prices').status, 'warn');
    rm(r2);
  });

  it('finds a repo an older ticket recorded with a relative path, and reads that row\'s base', () => {
    // A row's paths are absolute (README § Definitions, `<.claude>`); records written before that was spelled
    // out hold "<repo-name>". Resolved against this script's cwd the repo is lost — it is neither discovered
    // (nothing checks its remote) nor matched in baseOf (the base the ticket recorded is ignored). Resolved
    // against the project folder around <.claude> it is found. The checkout sits one level deeper than the
    // fallback scan reaches, so only the recorded path can produce it.
    const r4 = tmp('doctor-'); const c4 = install(r4);
    const repo = repoWithRemote(join(r4, 'nested'), 'svc');
    hooksFor(repo);
    git(repo, ['push', '-q', 'origin', 'main:develop']); // a base only the recorded row names
    const t = pickedUp(c4, { id: 'T-9', repos: [{ name: 'svc', path: 'nested/svc', branch: 'feat/x' }] });
    const tj = readJson(t, 'ticket.json'); tj.repos[0].base = 'develop'; writeJson(t, 'ticket.json', tj);

    const d = doctor('run', c4).json; // no --repos: the repos come from what the tickets recorded
    assert.equal(byName(d, 'repo svc')?.status, 'ok', JSON.stringify(d.checks.map((x) => [x.name, x.status, x.detail])));
    assert.match(byName(d, 'repo svc').detail, /svc\.git · base develop/);
    assert.equal(byName(d, 'repos'), undefined, 'the "no git checkout found" warning is for an install with none');
    rm(r4);
  });

  it('fresh reports missing, stale and failing preflights; add appends or replaces a check', () => {
    const r3 = tmp('doctor-'); const c3 = install(r3);
    let f = doctor('fresh', c3);
    assert.deepEqual([f.code, f.json.fresh], [1, false]);
    doctor('run', c3, '--repos', api);
    f = doctor('fresh', c3);
    assert.deepEqual([f.code, f.json.fresh, f.json.ok], [0, true, true]);
    const a = doctor('add', c3, JSON.stringify({ name: 'tracker', status: 'fail', detail: 'no tool', fix: 'connect it' }));
    assert.equal(a.code, 0);
    assert.equal(a.json.ok, false);
    f = doctor('fresh', c3);
    assert.deepEqual([f.code, f.json.ok], [2, false]);
    assert.match(f.json.why, /tracker/);
    doctor('add', c3, JSON.stringify({ name: 'tracker', status: 'ok', detail: 'answered' }));
    assert.equal(doctor('fresh', c3).code, 0);
    assert.equal(readJson(join(c3, 'work'), '_doctor.json').checks.filter((x) => x.name === 'tracker').length, 1, 'replaced, not duplicated');
    // stale: an old stamp
    const file = join(c3, 'work', '_doctor.json'); const d = readJson(join(c3, 'work'), '_doctor.json'); d.at = stampAgo(30 * 3600000).replace(/Z$/, ':00Z'); writeFileSync(file, JSON.stringify(d));
    f = doctor('fresh', c3);
    assert.deepEqual([f.code, f.json.fresh], [1, false]);
    assert.equal(doctor('add', c3, '{ "name": "x" }').code, 2, 'a check needs a status');
    rm(r3);
  });

  it('refuses a directory without skills/', () => {
    const r = doctor('run', tmp('doctor-'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a \.claude directory/);
  });
});
