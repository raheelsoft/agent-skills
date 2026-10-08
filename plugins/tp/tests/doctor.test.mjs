// doctor.mjs — the preflight, on throw-away installs with real git repos and bare remotes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, LIB, tmp, rm, writeJson, readJson, pickedUp, stampAgo, script } from './helpers.mjs';

const DOCTOR = script('doctor.mjs');
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
/** A throw-away project `.claude`: tiers.json, settings with the Install rules (naming the plugin's scripts), an empty work root. The skills are the plugin's. */
function install(root, tiers = {}) {
  const c = join(root, '.claude');
  mkdirSync(join(c, 'work'), { recursive: true });
  writeJson(c, 'tiers.json', { ceiling: 'c', ladder: ['a', 'b', 'c'], low: 'a', medium: 'b', high: 'c', prices: { low: 1, medium: 2, high: 3 }, ...tiers });
  writeJson(c, 'notify.json', { tool: 'chat', target: '#dev', project: 'p', levels: ['stop'], setAt: 'x' });
  writeJson(join(c, 'work'), '_heartbeat.json', { at: new Date().toISOString(), source: 'startup', session: 's', plugin: '0.2.0' }); // what the plugin's SessionStart hook writes
  writeJson(c, 'settings.local.json', { permissions: { allow: [`Bash(node ${LIB}/*)`, `Bash(node ${PLUGIN_ROOT}/office/*)`, 'Bash(node --test *)', 'Bash(git *)', `Edit(//${c.replace(/^\/+/, '')}/worktrees/**)`] } });
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
    for (const n of ['node', 'git', 'tiers.json', 'ceiling', 'notify', 'work', 'scripts', 'repo api', 'repo web', 'echo check', 'allowlist', 'skills', 'hooks api', 'hooks web']) assert.equal(byName(d, n)?.status, 'ok', n);
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
    // A row's paths are absolute (reference/definitions.md § Definitions, `<.claude>`); records written before that was spelled
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

  it('refuses a path that is not a folder', () => {
    const r = doctor('run', join(tmp('doctor-'), 'not-there'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /is not a folder — it is the project's \.claude/);
  });

  it('warns when the deny rules do not match pipeline.json, and says so when they do', () => {
    const r7 = tmp('doctor-'); const c7 = install(r7);
    assert.equal(byName(doctor('run', c7).json, 'skill enforcement').status, 'ok', 'every skill on: nothing to deny');
    writeJson(c7, 'pipeline.json', { skills: { merge: false }, setAt: 'x', by: 'hand' }); // off in the record, no rule yet
    let e = byName(doctor('run', c7).json, 'skill enforcement');
    assert.equal(e.status, 'warn');
    assert.match(e.detail, /1 deny rule\(s\) missing, 0 left over in settings\.json/);
    assert.match(e.fix, /setup\.mjs sync/);
    assert.equal(spawnSync(process.execPath, [script('setup.mjs'), 'sync', c7], { encoding: 'utf8' }).status, 0);
    e = byName(doctor('run', c7).json, 'skill enforcement');
    assert.equal(e.status, 'ok');
    assert.match(e.detail, /1 off skill\(s\) denied to the model/);
    rm(r7);
  });

  it('checks the work directory\'s JSON against its schemas: ok when it matches, a warning with the file and the error when it does not', () => {
    const r8 = tmp('doctor-'); const c8 = install(r8);
    assert.equal(byName(doctor('run', c8).json, 'contracts').detail, 'no artifacts yet');
    const dir = join(c8, 'work', 'T-9'); mkdirSync(dir, { recursive: true });
    writeJson(dir, 'plan.json', { status: 'ready', flags: [], steps: 2, openQuestions: 0, complexity: 'low' });
    let k = byName(doctor('run', c8).json, 'contracts');
    assert.deepEqual([k.status, k.detail], ['ok', '1 artifacts match their schemas']);
    writeJson(dir, 'plan.json', { status: 'ready', flags: [], steps: 2, openQuestions: 0, complexity: 'epic' });
    k = byName(doctor('run', c8).json, 'contracts');
    assert.equal(k.status, 'warn');
    assert.match(k.detail, /1 of 1 artifacts do not match their schema: T-9\/plan\.json \(\$\.complexity: expected one of/);
    assert.match(k.fix, /validate\.mjs work .*work/);
    writeJson(dir, 'plan.json', { steps: [1, 2], openQuestions: [], complexity: 'low' }); // an older plan: read mode accepts it
    assert.equal(byName(doctor('run', c8).json, 'contracts').status, 'ok');
    rm(r8);
  });

  it('warns when the plugin\'s hooks have left no heartbeat, or an old one, and says so when they have', () => {
    const r9 = tmp('doctor-'); const c9 = install(r9);
    let h = byName(doctor('run', c9).json, 'hooks heartbeat');
    assert.equal(h.status, 'ok');
    assert.match(h.detail, /^startup 0h ago, plugin 0\.2\.0$/);
    writeJson(join(c9, 'work'), '_heartbeat.json', { at: new Date(Date.now() - 100 * 3600000).toISOString(), source: 'resume', session: 's', plugin: '0.2.0' });
    h = byName(doctor('run', c9).json, 'hooks heartbeat');
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /the last heartbeat is 100h old .*doctor\.heartbeatHours is 72/);
    writeJson(c9, 'tiers.json', { ceiling: 'c', ladder: ['a', 'b', 'c'], low: 'a', medium: 'b', high: 'c', prices: { low: 1, medium: 2, high: 3 }, doctor: { heartbeatHours: 200 } });
    assert.equal(byName(doctor('run', c9).json, 'hooks heartbeat').status, 'ok', 'the window is configurable');
    rm(join(c9, 'work', '_heartbeat.json'));
    h = byName(doctor('run', c9).json, 'hooks heartbeat');
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /no heartbeat: the plugin's hooks have not run in this project, so its guards are not active/);
    assert.match(h.fix, /SessionStart writes it/);
    rm(r9);
  });

  it('warns while a copy of the pipeline is still in the project\'s .claude, and says so when none is', () => {
    const r6 = tmp('doctor-'); const c6 = install(r6);
    assert.equal(byName(doctor('run', c6).json, 'project copy').status, 'ok');
    mkdirSync(join(c6, 'skills', 'tp-merge'), { recursive: true });
    const w = byName(doctor('run', c6).json, 'project copy');
    assert.equal(w.status, 'warn');
    assert.match(w.detail, /skills\/tp-merge/);
    assert.match(w.fix, /setup\.mjs migrate/);
    rm(r6);
  });

  it('wants the Edit rule for this project\'s worktrees folder, in the absolute form the runtime reads', () => {
    const r7 = tmp('doctor-'); const c7 = install(r7);
    writeJson(c7, 'settings.local.json', { permissions: { allow: [`Bash(node ${LIB}/*)`, `Bash(node ${PLUGIN_ROOT}/office/*)`, 'Bash(node --test *)', 'Bash(git *)'] } });
    const a = byName(doctor('run', c7).json, 'allowlist');
    assert.equal(a.status, 'warn');
    assert.ok(a.detail.includes(`Edit(//${c7.replace(/^\/+/, '')}/worktrees/**)`), a.detail);
    rm(r7);
  });

  it('checks the allowlist against the plugin\'s own scripts, wherever the plugin is installed', () => {
    const r5 = tmp('doctor-'); const c5 = install(r5);
    writeJson(c5, 'settings.local.json', { permissions: { allow: ['Bash(node /somewhere/else/lib/*)', 'Bash(git *)', 'Bash(node --test *)'] } });
    const d = doctor('run', c5).json;
    assert.equal(byName(d, 'allowlist').status, 'warn');
    assert.ok(byName(d, 'allowlist').detail.includes(`node ${LIB}/*`), 'the missing rule names this plugin\'s lib folder');
    rm(r5);
  });
});

describe('doctor.mjs — the folders that are per machine', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  it('in a project that is a git repository, warns until .claude/work/ and .claude/worktrees/ are ignored', () => {
    const r = tmp('doctor-'); const c = install(r);
    git(r, 'init', '-q', '-b', 'main');
    const open = byName(doctor('run', c).json, 'gitignore');
    assert.equal(open.status, 'warn');
    assert.match(open.detail, /\.claude\/work\/ and \.claude\/worktrees\/ not ignored/);
    writeFileSync(join(r, '.gitignore'), '.claude/work/\n');
    assert.match(byName(doctor('run', c).json, 'gitignore').detail, /^\.claude\/worktrees\/ not ignored/);
    writeFileSync(join(r, '.gitignore'), '.claude/work/\n.claude/worktrees/\n');
    assert.equal(byName(doctor('run', c).json, 'gitignore').status, 'ok');
    rm(r);
  });

  it('says nothing about it when the project folder is not a git repository', () => {
    const r = tmp('doctor-'); const c = install(r);
    assert.equal(byName(doctor('run', c).json, 'gitignore'), undefined);
    rm(r);
  });
});

describe('doctor.mjs — the ceiling', () => {
  let root;
  before(() => { root = tmp('doctor-ceiling-'); });
  after(() => rm(root));
  const LADDER = ['fast-model', 'standard-model', 'strongest-model', 'frontier-model']; // fake names; none is a substring of another
  const CAPPED = { ceiling: 'standard-model', ladder: LADDER, low: 'fast-model', medium: 'standard-model', high: 'standard-model' };
  /** An install whose tiers.json is `tiers`, and whose settings.local.json also holds `settings`. */
  const at = (name, tiers, settings = {}) => {
    const c = install(join(root, name), tiers);
    writeJson(c, 'settings.local.json', { ...readJson(c, 'settings.local.json'), ...settings });
    return c;
  };

  it('warns when tiers.json records no ceiling, and checks nothing against one', () => {
    const d = doctor('run', at('none', { ceiling: undefined, ladder: undefined })).json;
    const c = byName(d, 'ceiling');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /no ceiling/);
    assert.match(c.fix, /\/tp:setup/);
    assert.equal(byName(d, 'starting model'), undefined);
    assert.equal(byName(d, 'session model'), undefined);
  });

  it('passes a ceiling its tiers agree with, and names the models the pipeline uses', () => {
    const c = byName(doctor('run', at('ok', CAPPED)).json, 'ceiling');
    assert.equal(c.status, 'ok');
    assert.match(c.detail, /standard-model — the pipeline uses fast-model, standard-model/);
  });

  it('warns, with the fix, when a tier is above the ceiling or off the ladder, or the ceiling has no ladder', () => {
    let c = byName(doctor('run', at('above', { ...CAPPED, high: 'frontier-model' })).json, 'ceiling');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /high=frontier-model is above the ceiling standard-model: it runs on standard-model/);
    assert.match(c.fix, /model\.mjs tiers .* ceiling=standard-model/);
    c = byName(doctor('run', at('off', { ...CAPPED, medium: 'custom' })).json, 'ceiling');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /medium=custom is not on the ladder/);
    c = byName(doctor('run', at('no-ladder', { ceiling: 'standard-model', ladder: undefined })).json, 'ceiling');
    assert.match(c.detail, /has no ladder/);
    assert.match(c.fix, /\/tp:setup/, 'with no ladder the script cannot derive the tiers: the interview writes it');
  });

  it('warns when the model the settings start a session on is above the ceiling, and passes one within it', () => {
    let d = doctor('run', at('start-above', CAPPED, { model: 'claude-frontier-model-1' })).json;
    let s = byName(d, 'starting model');
    assert.equal(s.status, 'warn');
    assert.match(s.detail, /settings\.local\.json starts sessions on claude-frontier-model-1, above the ceiling standard-model/);
    assert.match(s.fix, /model\.mjs pin/);
    d = doctor('run', at('start-ok', CAPPED, { model: 'fast-model' })).json;
    assert.equal(byName(d, 'starting model').status, 'ok');
    assert.equal(byName(doctor('run', at('start-none', CAPPED)).json, 'starting model'), undefined, 'no model set: nothing to say');
    s = byName(doctor('run', at('start-odd', CAPPED, { model: 'best' })).json, 'starting model');
    assert.equal(s.status, 'warn');
    assert.match(s.detail, /not on the ladder.*the ceiling cannot be checked for it/);
  });

  it('warns when the session that invoked it is above the ceiling — only when it is named', () => {
    const c = at('session', CAPPED);
    let s = byName(doctor('run', c, '--session', 'claude-frontier-model-5').json, 'session model');
    assert.equal(s.status, 'warn');
    assert.match(s.detail, /this session runs on claude-frontier-model-5, above the ceiling standard-model/);
    assert.match(s.fix, /\/model standard-model/);
    s = byName(doctor('run', c, '--session', 'claude-standard-model-5-5').json, 'session model');
    assert.equal(s.status, 'ok');
    assert.equal(byName(doctor('run', c).json, 'session model'), undefined, 'no session named, none checked');
  });
});
