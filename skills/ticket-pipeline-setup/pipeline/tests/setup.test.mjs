// setup.mjs — the integration interview's mechanics: the catalogue, its dependencies, pipeline.json, the folders of
// skills that are off, and what the state script leaves out when a stage's skill is off (README § Definitions, Active skills).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, CLAUDE_DIR, writeJson, pickedUp, append, ARTEFACTS, state } from './helpers.mjs';
import { GROUPS, CATALOGUE, PREFIX } from '../skills/_lib/setup.mjs';

const SETUP = join(CLAUDE_DIR, 'skills', '_lib', 'setup.mjs');
const setup = (...args) => { const r = spawnSync(process.execPath, [SETUP, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8' }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* an error */ } return { code: r.status, json, err: r.stderr }; };

/** A fake <.claude> with one folder per catalogue skill (a SKILL.md with a description) plus setup. */
function install(root) {
  const claude = join(root, '.claude');
  for (const name of [...Object.keys(CATALOGUE), 'tp-setup']) {
    mkdirSync(join(claude, 'skills', name), { recursive: true });
    writeFileSync(join(claude, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: what ${name} does\nuser_invocable: true\n---\n`);
  }
  mkdirSync(join(claude, 'work'), { recursive: true });
  return claude;
}

describe('setup.mjs — the catalogue', () => {
  it('lists every skill by group with its description, dependencies, default and state', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = install(root);
    const r = setup('list', claude);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.groups.map((g) => g.name), ['ticket pipeline', 'review and merge', 'after the merge', 'the day', 'tooling']);
    const all = r.json.groups.flatMap((g) => g.skills);
    assert.equal(all.length, 20);
    const merge = all.find((s) => s.name === 'tp-merge');
    assert.deepEqual([merge.description, merge.requires, merge.default, merge.on, merge.present], ['what tp-merge does', ['tp-review', 'tp-create-pr'], true, true, true]);
    assert.equal(all.find((s) => s.name === 'tp-schedule').default, false, 'the scheduler is not preselected');
    assert.equal(r.json.pipeline, null, 'no pipeline.json yet: everything on');
  });

  it('the README\'s skills table names every catalogue skill, and nothing the catalogue does not know', () => {
    const readme = readFileSync(join(CLAUDE_DIR, 'skills', 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('## The skills'), readme.indexOf('## How it works'));
    const rows = [...table.matchAll(/^\| `\/([\w-]+)[^`]*` \| ([^|]+) \| (.+) \|$/gm)].map((m) => ({ name: m[1], group: m[2].trim(), text: m[3].trim() }));
    assert.deepEqual(rows.map((r) => r.name).sort(), [...Object.keys(CATALOGUE), 'tp-setup'].sort());
    assert.ok(rows.every((r) => r.name.startsWith(PREFIX)), 'every row is invoked by its prefixed name');
    for (const r of rows) if (r.name !== 'tp-setup') assert.equal(r.group, CATALOGUE[r.name].group, `${r.name}'s group in the README`);
    for (const r of rows) assert.ok(r.text.length > 40, `${r.name} has a description`);
    // and every installed skill folder is in the catalogue (or is the interview itself)
    // skills/ holds one folder per skill plus the docs for people (README.md, flowcharts.md)
    const folders = readdirSync(join(CLAUDE_DIR, 'skills')).filter((n) => !n.startsWith('_') && !n.endsWith('.md'));
    assert.deepEqual(folders.sort(), [...Object.keys(CATALOGUE), 'tp-setup'].sort());
  });

  it('check: the closure of a selection under requires, with who pulled what in; unknown names refused', () => {
    const r = setup('check', '.', { skills: ['tp-merge', 'tp-status'] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.skills, ['tp-create-pr', 'tp-verify', 'tp-review', 'tp-merge', 'tp-status']);
    assert.deepEqual(r.json.added.map((a) => a.name).sort(), ['tp-create-pr', 'tp-review', 'tp-verify']);
    assert.ok(r.json.added.every((a) => CATALOGUE[a.for].requires.includes(a.name)), 'each addition names a skill that requires it');
    assert.ok(r.json.off.includes('tp-run-ticket') && r.json.off.includes('tp-plan-day'));
    const bad = setup('check', '.', { skills: ['tp-merge', 'nope'] });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown skill\(s\): nope/);
    const sched = setup('check', '.', { skills: ['tp-schedule'] });
    assert.deepEqual(sched.json.skills, ['tp-run-ticket', 'tp-start-ticket', 'tp-triage', 'tp-plan', 'tp-implement', 'tp-create-pr', 'tp-verify', 'tp-plan-day', 'tp-inbox', 'tp-eod', 'tp-schedule'], 'schedule pulls the day in, plan-day pulls the pipeline in');
  });
});

describe('setup.mjs — apply, status, and what the pipeline does with an off skill', () => {
  it('apply writes pipeline.json and moves the folders of off skills aside; a second apply brings them back', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = install(root);
    const r = setup('apply', claude, { skills: ['tp-run-ticket', 'tp-merge', 'tp-status', 'tp-doctor'], by: 'test' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.off.sort(), ['tp-accept', 'tp-create-ticket', 'tp-eod', 'tp-inbox', 'tp-notify', 'tp-plan-day', 'tp-release', 'tp-retro', 'tp-schedule'].sort());
    assert.deepEqual(r.json.moved.off.sort(), r.json.off.sort());
    for (const n of r.json.off) { assert.ok(!existsSync(join(claude, 'skills', n)), `${n} gone from skills/`); assert.ok(existsSync(join(claude, 'skills', '_off', n, 'SKILL.md')), `${n} kept under _off/`); }
    for (const n of r.json.on) assert.ok(existsSync(join(claude, 'skills', n, 'SKILL.md')), `${n} still installed`);
    assert.ok(existsSync(join(claude, 'skills', 'tp-setup', 'SKILL.md')), 'the interview itself is never moved');
    const pipeline = JSON.parse(readFileSync(join(claude, 'pipeline.json'), 'utf8'));
    assert.deepEqual([pipeline.skills['tp-merge'], pipeline.skills['tp-release'], pipeline.by], [true, false, 'test']);
    assert.equal(Object.keys(pipeline.skills).length, 20, 'every catalogue skill is listed explicitly');
    const st = setup('status', claude);
    assert.deepEqual([st.code, st.json.problems], [0, []]);
    assert.deepEqual(setup('stages', claude).json.off, ['release', 'accept']);
    // switch release back on
    const again = setup('apply', claude, { skills: ['tp-run-ticket', 'tp-merge', 'tp-status', 'tp-doctor', 'tp-release'] });
    assert.deepEqual(again.json.moved, { off: [], on: ['tp-release'] });
    assert.ok(existsSync(join(claude, 'skills', 'tp-release', 'SKILL.md')) && !existsSync(join(claude, 'skills', '_off', 'tp-release')));
    assert.deepEqual(setup('stages', claude).json.off, ['accept']);
  });

  it('status reports a skill on without its folder, an off skill still installed, and a dependency off', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = install(root);
    writeJson(claude, 'pipeline.json', { skills: { 'tp-merge': true, 'tp-review': false, 'tp-notify': false }, setAt: 'x', by: 'hand' });
    rm(join(claude, 'skills', 'tp-status'));
    const st = setup('status', claude);
    assert.equal(st.code, 1);
    assert.ok(st.json.problems.some((p) => /tp-status is on but skills\/tp-status\/ is missing/.test(p)));
    assert.ok(st.json.problems.some((p) => /tp-merge needs tp-review, which is off/.test(p)));
    assert.ok(st.json.problems.some((p) => /tp-notify is off but skills\/tp-notify\/ is still installed/.test(p)));
  });

  it('the state script leaves the stages of off skills out: a merged ticket is done, and old entries for them are no problem', (t) => {
    const root = tmp(); t.after(() => rm(root));
    // the work root is <root>/work, so <root> plays <.claude>
    mkdirSync(join(root, 'work'), { recursive: true });
    const dir = pickedUp(root, { id: 'T-7' });
    ARTEFACTS.triage(dir, 'direct'); ARTEFACTS.implement(dir); ARTEFACTS.pr(dir);
    append(dir, [['2026-01-01T10:06Z', 'triage', 'done', 'x'], ['2026-01-01T10:07Z', 'implement', 'done', 'x'], ['2026-01-01T10:08Z', 'create-pr', 'done', 'x'], ['2026-01-01T10:09Z', 'merge', 'done', 'merged abc']]);
    assert.equal(state('state', dir).json.next, 'release', 'everything on: release is next');
    writeJson(root, 'pipeline.json', { skills: { 'tp-release': false, 'tp-accept': false }, setAt: 'x', by: 'test' });
    const j = state('state', dir).json;
    assert.equal(j.next, null, 'release and accept off: the ticket is done after the merge');
    assert.deepEqual(j.stages.map((s) => s.name), ['start-ticket', 'triage', 'implement', 'create-pr', 'merge']);
    assert.deepEqual(j.problems, []);
    // an entry logged while release was still on is kept and never a problem
    append(dir, [['2026-01-01T10:10Z', 'release', 'done', 'x']]);
    assert.deepEqual(state('state', dir).json.problems, []);
    writeJson(root, 'pipeline.json', { skills: { 'tp-merge': false }, setAt: 'x', by: 'test' });
    assert.equal(state('state', dir).json.next, 'accept', 'merge off: create-pr is followed by release (done above), then accept');
    assert.ok(!state('state', dir).json.stages.some((s) => s.name === 'merge'));
  });
});

describe('setup — the prefix', () => {
  // Every skill is named <PREFIX><name> so none of them can be confused with a built-in, a plugin's or a personal
  // skill of the same word — "status", "doctor", "review", "schedule" are all names something else already uses.
  it('a selection written before the prefix still says what it meant', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = install(root);
    writeJson(claude, 'pipeline.json', { skills: { merge: false, review: false }, setAt: 'x', by: 'an older install' });
    const st = setup('status', claude);
    assert.ok(st.json.off.includes('tp-merge') && st.json.off.includes('tp-review'), 'the old keys name today\'s skills');
    assert.ok(st.json.on.includes('tp-run-ticket'), 'everything it did not name stays on');
  });

  it('the folder, the frontmatter name and the slash command are the same prefixed string', () => {
    for (const name of [...Object.keys(CATALOGUE), 'tp-setup']) {
      const t = readFileSync(join(CLAUDE_DIR, 'skills', name, 'SKILL.md'), 'utf8');
      assert.match(t, new RegExp(`^name: ${name}$`, 'm'), `skills/${name}/SKILL.md names its folder`);
      assert.ok(name.startsWith(PREFIX), `${name} carries the prefix`);
    }
  });
});

describe('setup — the interview\'s catalogue is consistent', () => {
  it('every requires target exists, groups are non-empty, the interview itself is not in the catalogue', () => {
    for (const s of Object.values(CATALOGUE)) for (const r of s.requires) assert.ok(CATALOGUE[r], `${s.name} requires ${r}`);
    for (const g of GROUPS) assert.ok(g.skills.length && g.why);
    assert.ok(!CATALOGUE['tp-setup'], 'the interview is never in the catalogue');
    assert.ok(Object.keys(CATALOGUE).every((n) => n.startsWith(PREFIX)), 'every catalogue name carries the prefix');
  });
});
