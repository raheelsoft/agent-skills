// setup.mjs — the integration interview's mechanics: the catalogue, its dependencies, pipeline.json, and what the state script
// leaves out when a stage's skill is off (README § Definitions, Active skills). The skills live in the plugin; a project only records its choice.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, PLUGIN_ROOT, writeJson, pickedUp, append, ARTEFACTS, state, script } from './helpers.mjs';
import { GROUPS, CATALOGUE, NS, slash, normalize, modern } from '../lib/setup.mjs';

const SETUP = script('setup.mjs');
const setup = (...args) => { const r = spawnSync(process.execPath, [SETUP, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8' }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* no JSON */ } return { code: r.status, json, err: r.stderr }; };

/** A fake project `.claude`: its configuration and work/ — the skills are the plugin's, not copied here. */
function project(root) {
  const claude = join(root, '.claude');
  mkdirSync(join(claude, 'work'), { recursive: true });
  return claude;
}
const description = (name) => /^description:\s*(.+)$/m.exec(readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8'))[1].trim();

describe('setup.mjs — the catalogue', () => {
  it('lists every skill by group with its command, description, dependencies, default and state', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const r = setup('list', project(root));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.groups.map((g) => g.name), ['ticket pipeline', 'review and merge', 'after the merge', 'the day', 'tooling']);
    const all = r.json.groups.flatMap((g) => g.skills);
    assert.equal(all.length, 20);
    const merge = all.find((s) => s.name === 'merge');
    assert.deepEqual([merge.command, merge.description, merge.requires, merge.default, merge.on, merge.present], ['/tp:merge', description('merge'), ['review', 'create-pr'], true, true, true]);
    assert.equal(all.find((s) => s.name === 'schedule').default, false, 'the scheduler is not preselected');
    assert.equal(r.json.pipeline, null, 'no pipeline.json yet: everything on');
  });

  it('the README\'s skills table names every catalogue skill, and nothing the catalogue does not know', () => {
    const readme = readFileSync(join(PLUGIN_ROOT, 'reference', 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('## The skills'), readme.indexOf('## How it works'));
    const rows = [...table.matchAll(/^\| `\/tp:([\w-]+)[^`]*` \| ([^|]+) \| (.+) \|$/gm)].map((m) => ({ name: m[1], group: m[2].trim(), text: m[3].trim() }));
    assert.deepEqual(rows.map((r) => r.name).sort(), [...Object.keys(CATALOGUE), 'setup'].sort());
    for (const r of rows) if (r.name !== 'setup') assert.equal(r.group, CATALOGUE[r.name].group, `${r.name}'s group in the README`);
    for (const r of rows) assert.ok(r.text.length > 40, `${r.name} has a description`);
    // and the plugin ships exactly one folder per skill (the interview itself included)
    assert.deepEqual(readdirSync(join(PLUGIN_ROOT, 'skills')).sort(), [...Object.keys(CATALOGUE), 'setup'].sort());
  });

  it('check: the closure of a selection under requires, with who pulled what in; unknown names refused', () => {
    const r = setup('check', '.', { skills: ['merge', 'status'] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.skills, ['create-pr', 'verify', 'review', 'merge', 'status']);
    assert.deepEqual(r.json.added.map((a) => a.name).sort(), ['create-pr', 'review', 'verify']);
    assert.ok(r.json.added.every((a) => CATALOGUE[a.for].requires.includes(a.name)), 'each addition names a skill that requires it');
    assert.ok(r.json.off.includes('run-ticket') && r.json.off.includes('plan-day'));
    const bad = setup('check', '.', { skills: ['merge', 'nope'] });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown skill\(s\): nope/);
    const sched = setup('check', '.', { skills: ['schedule'] });
    assert.deepEqual(sched.json.skills, ['run-ticket', 'start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'verify', 'plan-day', 'inbox', 'eod', 'schedule'], 'schedule pulls the day in, plan-day pulls run-ticket in, and so on down');
  });

  it('names a skill however it was written: merge, tp:merge, /tp:merge and an older tp-merge', () => {
    for (const spelling of ['merge', 'tp:merge', '/tp:merge', 'tp-merge']) assert.equal(normalize(spelling), 'merge', spelling);
    const r = setup('check', '.', { skills: ['tp-merge', '/tp:status'] });
    assert.deepEqual(r.json.skills, ['create-pr', 'verify', 'review', 'merge', 'status']);
  });
});

describe('setup.mjs — apply, status, and what the pipeline does with an off skill', () => {
  it('apply records the choice in pipeline.json and moves nothing; a second apply changes the record', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = project(root);
    const r = setup('apply', claude, { skills: ['run-ticket', 'merge', 'status', 'doctor'], by: 'test' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.off.sort(), ['accept', 'create-ticket', 'eod', 'inbox', 'notify', 'plan-day', 'release', 'retro', 'schedule'].sort());
    assert.equal(r.json.moved, undefined, 'the skills are the plugin\'s: nothing is moved');
    assert.deepEqual(readdirSync(claude).sort(), ['pipeline.json', 'work'], 'the project gained pipeline.json and nothing else');
    const pipeline = JSON.parse(readFileSync(join(claude, 'pipeline.json'), 'utf8'));
    assert.deepEqual([pipeline.skills.merge, pipeline.skills.release, pipeline.by], [true, false, 'test']);
    assert.equal(Object.keys(pipeline.skills).length, 20, 'every catalogue skill is listed explicitly');
    const st = setup('status', claude);
    assert.deepEqual([st.code, st.json.problems], [0, []]);
    assert.deepEqual(setup('stages', claude).json.off, ['release', 'accept']);
    // switch release back on
    setup('apply', claude, { skills: ['run-ticket', 'merge', 'status', 'doctor', 'release'] });
    assert.equal(JSON.parse(readFileSync(join(claude, 'pipeline.json'), 'utf8')).skills.release, true);
    assert.deepEqual(setup('stages', claude).json.off, ['accept']);
  });

  it('status reports a dependency that is off and a name the plugin does not have', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = project(root);
    writeJson(claude, 'pipeline.json', { skills: { merge: true, review: false, notify: false, ghost: true }, setAt: 'x', by: 'hand' });
    const st = setup('status', claude);
    assert.equal(st.code, 1);
    assert.ok(st.json.problems.some((p) => /merge needs review, which is off/.test(p)));
    assert.ok(st.json.problems.some((p) => /pipeline\.json names ghost, which is not a skill of this plugin/.test(p)));
    assert.ok(!st.json.problems.some((p) => /notify/.test(p)), 'an off skill nothing needs is no problem');
  });

  it('the state script leaves the stages of off skills out: a merged ticket is done, and old entries for them are no problem', (t) => {
    const root = tmp(); t.after(() => rm(root));
    // the work root is <root>/work, so <root> plays the project's .claude
    mkdirSync(join(root, 'work'), { recursive: true });
    const dir = pickedUp(root, { id: 'T-7' });
    ARTEFACTS.triage(dir, 'direct'); ARTEFACTS.implement(dir); ARTEFACTS.pr(dir);
    append(dir, [['2026-01-01T10:06Z', 'triage', 'done', 'x'], ['2026-01-01T10:07Z', 'implement', 'done', 'x'], ['2026-01-01T10:08Z', 'create-pr', 'done', 'x'], ['2026-01-01T10:09Z', 'merge', 'done', 'merged abc']]);
    assert.equal(state('state', dir).json.next, 'release', 'everything on: release is next');
    writeJson(root, 'pipeline.json', { skills: { release: false, accept: false }, setAt: 'x', by: 'test' });
    const j = state('state', dir).json;
    assert.equal(j.next, null, 'release and accept off: the ticket is done after the merge');
    assert.deepEqual(j.stages.map((s) => s.name), ['start-ticket', 'triage', 'implement', 'create-pr', 'merge']);
    assert.deepEqual(j.problems, []);
    // an entry logged while release was still on is kept and never a problem
    append(dir, [['2026-01-01T10:10Z', 'release', 'done', 'x']]);
    assert.deepEqual(state('state', dir).json.problems, []);
    writeJson(root, 'pipeline.json', { skills: { merge: false }, setAt: 'x', by: 'test' });
    assert.equal(state('state', dir).json.next, 'accept', 'merge off: create-pr is followed by release (done above), then accept');
    assert.ok(!state('state', dir).json.stages.some((s) => s.name === 'merge'));
    // a pipeline.json an older install wrote, with its prefixed keys, says the same thing
    writeJson(root, 'pipeline.json', { skills: { 'tp-release': false, 'tp-accept': false }, setAt: 'x', by: 'an older install' });
    assert.equal(state('state', dir).json.next, null, 'tp-release and tp-accept are read as release and accept');
  });
});

describe('setup — the namespace', () => {
  // The plugin's name is the prefix: `merge` is run as `/tp:merge`, so none of the skills can be confused with a built-in, another plugin's or a
  // personal skill of the same word — "status", "doctor", "review", "schedule" are all names something else already uses.
  it('a skill is a bare name; its command and its Skill-tool name carry the namespace', () => {
    assert.equal(NS, 'tp:');
    assert.equal(slash('merge'), '/tp:merge');
    for (const name of [...Object.keys(CATALOGUE), 'setup']) {
      const t = readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      assert.match(t, new RegExp(`^name: ${name}$`, 'm'), `skills/${name}/SKILL.md names its folder`);
      assert.ok(!name.startsWith('tp-') && !name.includes(':'), `${name} carries no prefix of its own`);
    }
  });

  it('text an older install stored reads as today\'s commands, and paths and persisted file names are left alone', () => {
    assert.equal(modern('answer through /tp-run-ticket or /tp-plan-day, then /tp:merge'), 'answer through /tp:run-ticket or /tp:plan-day, then /tp:merge');
    assert.equal(modern('skills/tp-verify/SKILL.md and _scratch/tp-review-151.stop.json'), 'skills/tp-verify/SKILL.md and _scratch/tp-review-151.stop.json');
    assert.equal(modern('/tp-nothing'), '/tp-nothing', 'only a command the catalogue knows');
    assert.equal(modern(null), null);
  });

  it('the legacy-name spelling of the state script\'s resume strings is translated when it reads a stop', (t) => {
    const root = tmp(); t.after(() => rm(root));
    mkdirSync(join(root, 'work', '_scratch'), { recursive: true });
    writeJson(join(root, 'work', '_scratch'), 'tp-review-151.stop.json', { id: 'review:151', skill: 'review', question: 'Which branch? Answer, then /tp-merge 151', resume: '/tp-merge 151 answers="main"', kind: 'question', at: '2026-01-01T10:00Z' });
    const inbox = state('inbox', join(root, 'work')).json;
    assert.deepEqual([inbox[0].question, inbox[0].resume], ['Which branch? Answer, then /tp:merge 151', '/tp:merge 151 answers="main"']);
  });
});

describe('setup — the interview\'s catalogue is consistent', () => {
  it('every requires target exists, groups are non-empty, the interview itself is not in the catalogue', () => {
    for (const s of Object.values(CATALOGUE)) for (const r of s.requires) assert.ok(CATALOGUE[r], `${s.name} requires ${r}`);
    for (const g of GROUPS) assert.ok(g.skills.length && g.why);
    assert.ok(!CATALOGUE.setup, 'the interview is never in the catalogue');
    assert.ok(Object.keys(CATALOGUE).every((n) => !n.startsWith('tp')), 'a catalogue name is bare: the namespace is added by the plugin');
  });
});

describe('setup — moving from a project-local copy', () => {
  /** A project `.claude` as an older install left it: the pipeline copied in, `tp-` keys, allow rules naming the copy. */
  function legacy(root) {
    const claude = project(root);
    for (const d of ['skills/tp-merge', 'skills/_lib', 'skills/_off/tp-retro', 'office', 'tests']) mkdirSync(join(claude, d), { recursive: true });
    for (const f of ['skills/README.md', 'skills/_lib/state.mjs', 'office/serve.mjs', 'tests/helpers.mjs', 'tests/state.test.mjs']) writeFileSync(join(claude, f), 'x');
    writeJson(claude, 'pipeline.json', { skills: { 'tp-merge': false, review: true }, setAt: 'x', by: 'an older install' });
    writeJson(claude, 'settings.local.json', { permissions: { allow: [`Bash(node ${claude}/skills/_lib/*)`, `Bash(node ${claude}/office/*)`, 'Bash(git status*)'] } });
    return claude;
  }

  it('lists what is left of the copy, the old keys and the allow rules naming it — and deletes nothing', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = legacy(root);
    const r = setup('migrate', claude);
    assert.equal(r.code, 1, 'exit 1 while something is left');
    assert.deepEqual(r.json.copy, ['skills/README.md', 'skills/_lib', 'skills/_off', 'skills/tp-merge', 'tests', 'office']);
    assert.deepEqual(r.json.pipeline, { legacyKeys: ['tp-merge'], fixed: false });
    assert.equal(r.json.permissions.length, 2);
    assert.ok(r.json.permissions.every((p) => p.file === 'settings.local.json'));
    assert.ok(existsSync(join(claude, 'skills', 'tp-merge')) && existsSync(join(claude, 'office', 'serve.mjs')), 'nothing was removed');
  });

  it('--fix rewrites the keys of pipeline.json as bare names and leaves everything else alone', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = legacy(root);
    const r = setup('migrate', claude, '--fix');
    assert.equal(r.json.pipeline.fixed, true);
    const p = JSON.parse(readFileSync(join(claude, 'pipeline.json'), 'utf8'));
    assert.deepEqual([p.skills.merge, p.skills.review, 'tp-merge' in p.skills, p.by], [false, true, false, 'an older install']);
    assert.deepEqual(setup('migrate', claude).json.pipeline.legacyKeys, [], 'the old keys are gone');
    assert.ok(existsSync(join(claude, 'skills', '_lib', 'state.mjs')), 'the copy itself is the person\'s to remove');
  });

  it('a project with no copy has nothing left, and says so with exit 0', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const r = setup('migrate', project(root));
    assert.deepEqual([r.code, r.json.nothingLeft, r.json.copy], [0, true, []]);
  });

  it('a project\'s own tests and office folders are not mistaken for the pipeline\'s', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const claude = project(root);
    mkdirSync(join(claude, 'tests'), { recursive: true }); writeFileSync(join(claude, 'tests', 'my.test.mjs'), 'x');
    mkdirSync(join(claude, 'office'), { recursive: true }); writeFileSync(join(claude, 'office', 'notes.md'), 'x');
    assert.equal(setup('migrate', claude).json.nothingLeft, true);
  });
});
