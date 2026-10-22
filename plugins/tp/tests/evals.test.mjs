// The eval suite (evals/): every case is a well-formed case.yaml the runtime will load, with a scaffold that exists and graders that can pass.
// Running the suite costs tokens and is on demand (evals/README.md); this keeps its files honest for free.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { validate } from '../lib/contract/index.mjs';

const EVALS = join(PLUGIN_ROOT, 'evals');
const schema = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'eval-case.schema.json'), 'utf8'));
const cases = readdirSync(EVALS).filter((d) => existsSync(join(EVALS, d, 'case.yaml'))).sort();
const read = (name) => JSON.parse(readFileSync(join(EVALS, name, 'case.yaml'), 'utf8')); // JSON is YAML: the suite is written so a test needs no parser
const skills = new Set(readdirSync(join(PLUGIN_ROOT, 'skills')));
const SCENARIOS = ['empty', 'picked-up', 'triaged', 'implemented', 'pr-open', 'merged', 'released', 'accepted', 'planned', 'stopped', 'in-run'];

describe('the eval suite', () => {
  it('there are cases, and the smoke set covers the contract loop, a skill that reads, the guards, and the stages that write documents and code', () => {
    assert.ok(cases.length >= 17, `${cases.length} cases`);
    const smoke = cases.filter((c) => read(c).tags.includes('smoke'));
    for (const must of ['raw-write-then-put', 'status-one-ticket', 'inbox-stopped-ticket', 'no-verify-refused', 'plan-checker-read-only', 'researcher-needs-allowlist', 'start-ticket-fixture', 'triage-direct', 'plan-needs-plan', 'implement-direct', 'doctor-healthy', 'verify-gates', 'create-pr-fixture', 'release-fixture', 'accept-fixture', 'retro-fixture']) assert.ok(smoke.includes(must), `${must} is a smoke case`);
  });

  for (const name of cases) {
    describe(name, () => {
      const c = read(name);

      it('matches what the runtime accepts of a case.yaml', () => {
        assert.deepEqual(validate(schema, c, { load: () => schema }), []);
        assert.equal(c.name, name, 'the case is named by its folder');
        assert.ok(c.tags.some((t) => ['smoke', 'full'].includes(t)), 'tagged smoke or full: the tag picks it for a run');
      });

      it('its graders have unique names, patterns that compile, and a way to pass with the tools the case grants', () => {
        const names = c.graders.map((g) => g.name);
        assert.equal(new Set(names).size, names.length, 'unique grader names');
        for (const g of c.graders) {
          if (g.type === 'regex') assert.doesNotThrow(() => new RegExp(g.pattern, g.flags || ''), `${g.name}: ${g.pattern}`);
          if (g.type === 'tool_used' && g.input_match) assert.doesNotThrow(() => new RegExp(g.input_match), `${g.name}: ${g.input_match}`);
          if (g.type === 'tool_used') assert.ok(c.execution.allowed_tools.includes(g.tool) || ['Skill', 'Agent'].includes(g.tool), `${g.name}: the case does not grant ${g.tool}`);
          if (g.type === 'file_exists' && g.exists !== false) assert.ok(['Write', 'Edit', 'Bash'].some((t) => c.execution.allowed_tools.includes(t)), `${g.name}: nothing granted can create a file`);
        }
      });

      it('has a scaffold that is there, executable, and builds a scenario the bed knows', () => {
        const script = join(EVALS, name, c.context.scaffold_script);
        assert.ok(existsSync(script), `${c.context.scaffold_script} exists`);
        assert.ok(statSync(script).mode & 0o111, 'executable');
        const scenario = /bed\.mjs"? (\S+)/.exec(readFileSync(script, 'utf8'))?.[1];
        assert.ok(SCENARIOS.includes(scenario), `scenario ${scenario}`);
      });

      it('a prompt that types a command types one of this plugin\'s', () => {
        const typed = /^\/tp:([a-z-]+)/.exec(c.execution.prompt);
        if (typed) assert.ok(skills.has(typed[1]), `/tp:${typed[1]} is a skill`);
        for (const m of c.execution.prompt.matchAll(/subagent_type '(tp:[a-z-]+)'/g)) assert.ok(existsSync(join(PLUGIN_ROOT, 'agents', `${m[1].slice(3)}.md`)), `${m[1]} is an agent`);
      });

      it('runs once and is bounded in turns and time', () => {
        assert.equal(c.runs, 1, 'a smoke case runs once; --runs raises it for a full pass');
        assert.ok(c.execution.max_turns <= 60 && c.execution.timeout_seconds <= 900);
      });
    });
  }
});

describe('the scaffold — every scenario is a state the pipeline itself reads as valid', () => {
  // what the state script says is next (or what is waiting) in each bed, and that every file in it passes its schema
  const EXPECT = { 'picked-up': { next: 'triage' }, triaged: { next: 'implement' }, implemented: { next: 'create-pr' }, 'pr-open': { next: 'merge' }, merged: { next: 'release' }, released: { next: 'accept' }, accepted: { next: null },
    planned: { next: 'plan' }, stopped: { stopped: true }, 'in-run': { lock: true } };
  for (const [scenario, want] of Object.entries(EXPECT)) {
    it(`${scenario}: the state script finds nothing wrong and routes on`, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'bed-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
      const { bed } = await import('../evals/lib/bed.mjs');
      bed(dir, scenario);
      const wd = join(dir, '.claude', 'work', 'DEMO-4');
      const s = JSON.parse(execFileSync(process.execPath, [join(PLUGIN_ROOT, 'lib', 'state.mjs'), 'state', wd, '--brief'], { encoding: 'utf8' }));
      assert.deepEqual(s.problems, [], JSON.stringify(s.problems));
      if (want.next !== undefined) assert.equal(s.next, want.next);
      if (want.stopped) assert.ok(s.stopped);
      if (want.lock) assert.ok(s.lock);
      const v = JSON.parse(execFileSync(process.execPath, [join(PLUGIN_ROOT, 'lib', 'validate.mjs'), 'work', wd], { encoding: 'utf8' }));
      assert.deepEqual(v.invalid ?? [], [], JSON.stringify(v.invalid));
    });
  }

  it('a merged bed has the merge commit in the remote, an accepted one has no worktree left', async (t) => {
    const { bed } = await import('../evals/lib/bed.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'bed-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    bed(dir, 'accepted');
    const pr = JSON.parse(readFileSync(join(dir, '.claude', 'work', 'DEMO-4', 'pr.json'), 'utf8'));
    assert.equal(execFileSync('git', ['--git-dir', join(dir, 'api.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), pr.merged);
    assert.equal(existsSync(join(dir, '.claude', 'worktrees', 'DEMO-4')), false);
  });
});

describe('the scaffold', () => {
  it('builds a bed per scenario with the scripts the pipeline itself uses', () => {
    const src = readFileSync(join(EVALS, 'lib', 'bed.mjs'), 'utf8');
    for (const s of SCENARIOS) assert.match(src, new RegExp(`'${s}'`), s);
    assert.match(src, /putArtifact/, 'its work directory is made by the validated writer, not typed by hand');
  });
});
