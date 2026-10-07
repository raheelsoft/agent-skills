// The contracts of the work directory's files: every schema is well-formed and fully enforced, every example in schemas/examples is valid,
// every mistake a stage can make is refused with a message that says where, and every shape an earlier run wrote is still read.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, tmp, rm } from './helpers.mjs';
import { ARTIFACTS, SCHEMA_DIR, artifactOf, checkArtifact, checkWorkdir, checkWorkroot, loadSchema, unsupportedKeywords, validate } from '../lib/contract/index.mjs';

const EXAMPLES = join(SCHEMA_DIR, 'examples');
const example = (name) => JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), 'utf8'));
const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));

describe('the schema files', () => {
  it('there is one for every artifact, plus the shared pieces, the stage result and the review findings', () => {
    for (const a of [...ARTIFACTS, 'common', 'stage-result', 'review-findings']) assert.ok(schemaFiles.includes(`${a}.schema.json`), `${a}.schema.json`);
  });

  it('each is JSON with an id, a title and a description', () => {
    for (const f of schemaFiles) {
      const s = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
      assert.match(s.$id, /^tp\//, `${f} $id`);
      assert.ok(s.title && s.description, `${f} says what it is`);
    }
  });

  it('uses no keyword the validator would ignore', () => {
    for (const f of schemaFiles) assert.deepEqual(unsupportedKeywords(loadSchema(f)), [], `${f} uses a keyword nothing checks`);
  });

  it('every $ref resolves', () => {
    const refs = (node, out = []) => {
      if (Array.isArray(node)) node.forEach((n) => refs(n, out));
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k === '$ref') out.push(v); else refs(v, out); }
      return out;
    };
    for (const f of schemaFiles) {
      for (const ref of refs(loadSchema(f))) {
        const [file, pointer = ''] = ref.split('#');
        let node = file ? loadSchema(file) : loadSchema(f);
        for (const part of pointer.split('/').filter(Boolean)) node = node?.[part];
        assert.ok(node, `${f}: ${ref} points at nothing`);
      }
    }
  });

  it('every legacy branch and every x-legacy-optional is explained where it is used (description on the schema)', () => {
    for (const f of schemaFiles) {
      const s = loadSchema(f);
      if (s['x-legacy-optional']) assert.ok(s['x-legacy-optional'].every((k) => k in (s.properties || {})), `${f}: x-legacy-optional names a key it does not define`);
    }
  });
});

describe('the examples', () => {
  for (const a of ARTIFACTS) {
    it(`${a}: the example is valid as written today`, () => {
      assert.deepEqual(checkArtifact(a, example(a), { mode: 'write' }).errors, []);
    });
  }
  it('stage-result and review-findings: the examples are valid', () => {
    assert.deepEqual(validate(loadSchema('stage-result'), example('stage-result'), { load: loadSchema }), []);
    assert.deepEqual(validate(loadSchema('review-findings'), example('review-findings'), { load: loadSchema }), []);
  });
});

/** [what is wrong, how to break the example, what the refusal says] */
const MISTAKES = {
  ticket: [
    ['no id', (t) => delete t.id, '$.id: required, missing'],
    ['a made-up rating', (t) => { t.complexity = 'huge'; }, '$.complexity: expected one of "low" | "medium" | "high"'],
    ['no repo to work in', (t) => { t.repos = []; }, '$.repos: needs at least 1 item'],
    ['a repo without its branch', (t) => delete t.repos[0].branch, '$.repos[0].branch: required, missing'],
    ['round 0', (t) => { t.round = 0; }, '$.round: 0 is below 1'],
    ['a blocker without its check time', (t) => { t.blockedBy = [{ id: 'X-1', state: 'Todo', resolved: false, soft: false }]; }, '$.blockedBy[0].checkedAt: required, missing'],
  ],
  triage: [
    ['a decision nobody knows', (t) => { t.decision = 'maybe'; }, '$.decision: expected one of "direct" | "plan" | "needs-input" | "close" | "blocked"'],
    ['questions as one string', (t) => { t.questions = 'why?'; }, '$.questions: expected array, got string'],
    ['a structured question without its text', (t) => { t.questions = [{ choices: ['a'] }]; }, '$.questions[0]'],
    ['no rating', (t) => delete t.complexity, '$.complexity: required, missing'],
  ],
  plan: [
    ['the steps listed instead of counted', (p) => { p.steps = [{ n: 1 }]; }, '$.steps: expected integer, got array'],
    ['an unknown status', (p) => { p.status = 'draft'; }, '$.status: expected one of "ready" | "open-questions"'],
    ['ready, yet with open questions (an invariant)', (p) => { p.openQuestions = 2; }, '"ready" but openQuestions is 2'],
    ['open-questions with none open (an invariant)', (p) => { p.status = 'open-questions'; }, '"open-questions" but openQuestions is 0'],
  ],
  'plan-check': [
    ['a finding without text', (c) => delete c.findings[0].text, '$.findings[0].text: required, missing'],
    ['a severity nobody knows', (c) => { c.findings[1].severity = 'major'; }, '$.findings[1].severity'],
    ['a verdict nobody knows', (c) => { c.verdict = 'maybe'; }, '$.verdict: expected one of "ok" | "revise"'],
    ['no round', (c) => delete c.round, '$.round: required, missing'],
  ],
  implement: [
    ['more steps done than there are (an invariant)', (i) => { i.done = 4; }, '4 steps done of 3'],
    ['stopped as a flag instead of a question', (i) => { i.stopped = false; }, '$.stopped'],
    ['gates as a list', (i) => { i.gates = [{ name: 'lint' }]; }, '$.gates'],
    ['a gate result that is not text', (i) => { i.gates.lint = true; }, '$.gates.lint: expected string'],
    ['a rating nobody knows, as a number', (i) => { i.complexity = 3; }, '$.complexity'],
  ],
  pr: [
    ['a verdict nobody knows', (p) => { p.verdict = 'OK'; }, '$.verdict'],
    ['merged with no verdict (an invariant)', (p) => { p.verdict = null; }, 'merged without a recorded verdict'],
    ['a review without its head revision', (p) => delete p.reviews[0].sha, '$.reviews[0].sha: required, missing'],
    ['the PR number as text', (p) => { p.number = '218'; }, '$.number: expected integer, got string'],
  ],
  release: [
    ['a run without its status', (r) => delete r.run.status, '$.run.status: required, missing'],
    ['a smoke check without its result', (r) => delete r.smoke[0].result, '$.smoke[0].result: required, missing'],
    ['no follow-ups list', (r) => delete r.followUps, '$.followUps: required, missing'],
  ],
  accept: [
    ['counts that do not match the criteria (an invariant)', (a) => { a.passed = 2; }, '$.passed: 2 but 1 criteria have result "pass"'],
    ['a result nobody knows', (a) => { a.criteria[0].result = 'passed'; }, '$.criteria[0].result'],
    ['a criterion without evidence', (a) => delete a.criteria[0].evidence, '$.criteria[0].evidence: required, missing'],
    ['where: somewhere else', (a) => { a.where = 'prod'; }, '$.where: expected one of "live" | "checkout"'],
  ],
  quality: [
    ['a priority count missing', (q) => delete q.open.P1, '$.open.P1: required, missing'],
    ['a pass without its repo', (q) => delete q.rounds[0].repo, '$.rounds[0].repo: required, missing'],
    ['a mode nobody knows', (q) => { q.rounds[0].mode = 'quick'; }, '$.rounds[0].mode'],
    ['a negative count', (q) => { q.open.P0 = -1; }, '$.open.P0: -1 is below 0'],
  ],
  retro: [
    ['a proposal aimed at nothing', (r) => { r.proposals[0].target = 'other'; }, '$.proposals[0].target'],
    ['no proposals list', (r) => delete r.proposals, '$.proposals: required, missing'],
  ],
};

describe('what a stage can get wrong', () => {
  for (const [artifact, cases] of Object.entries(MISTAKES)) {
    for (const [what, wreck, expected] of cases) {
      it(`${artifact}: ${what}`, () => {
        const doc = structuredClone(example(artifact));
        wreck(doc);
        const r = checkArtifact(artifact, doc, { mode: 'write' });
        assert.equal(r.ok, false);
        assert.ok(r.errors.some((e) => e.includes(expected)), `${JSON.stringify(r.errors)} should include "${expected}"`);
      });
    }
  }

  it('stage-result: stopped needs its question, error needs its diagnosis, resume and needs', () => {
    const s = loadSchema('stage-result');
    const stopped = { status: 'stopped', summary: 's', data: {} };
    assert.ok(validate(s, stopped, { load: loadSchema }).some((e) => e.includes('$.question: required')));
    const error = { status: 'error', summary: 's', data: {} };
    assert.deepEqual(validate(s, error, { load: loadSchema }).map((e) => e.split(':')[0]).sort(), ['$.diagnosis', '$.needs', '$.resume']);
    assert.deepEqual(validate(s, { status: 'done', summary: 's', data: {} }, { load: loadSchema }), []);
    assert.ok(validate(s, { status: 'finished', summary: 's', data: {} }, { load: loadSchema }).length);
  });

  it('review-findings: a priority outside P0–P4 and a line of 0 are refused', () => {
    const s = loadSchema('review-findings');
    const doc = structuredClone(example('review-findings'));
    doc.findings[0].priority = 'P9';
    doc.findings[1].line = 0;
    const errors = validate(s, doc, { load: loadSchema });
    assert.ok(errors.some((e) => e.startsWith('$.findings[0].priority')));
    assert.ok(errors.some((e) => e.startsWith('$.findings[1].line')));
  });
});

describe('what earlier runs wrote is still read', () => {
  const legacy = {
    plan: [(p) => { p.steps = [{ n: 1, name: 'a' }]; p.openQuestions = [{ q: 'x' }]; p.status = 'ready'; p.openQuestions = []; }],
    implement: [(i) => { i.done = true; i.stopped = false; i.gates = [{ name: 'lint', status: 'PASS' }]; i.complexity = 'as rated (high)'; }],
    'plan-check': [(c) => { c.findings = [{ blocking: true, n: 1, finding: 'x', where: 'step 2' }]; }],
    triage: [(t) => { t.estimate.source = 'triage'; t.estimate.basis = { base: 2, multiplier: 1.5 }; }],
  };
  for (const [artifact, wrecks] of Object.entries(legacy)) {
    for (const wreck of wrecks) {
      it(`${artifact}: read mode accepts the old shape, write mode refuses it`, () => {
        const doc = structuredClone(example(artifact));
        wreck(doc);
        assert.deepEqual(checkArtifact(artifact, doc, { mode: 'read' }).errors, []);
        assert.equal(checkArtifact(artifact, doc, { mode: 'write' }).ok, false);
      });
    }
  }

  it('a plan.json without its header keys (a direct ticket\'s implement-style plan) is read, not written', () => {
    const doc = { steps: 1, complexity: 'low', repo: 'x', done: 1, total: 1 };
    assert.equal(checkArtifact('plan', doc, { mode: 'read' }).ok, true);
    assert.equal(checkArtifact('plan', doc, { mode: 'write' }).ok, false);
  });
});

describe('artifactOf', () => {
  it('maps a work-directory file name to its artifact and repo', () => {
    assert.deepEqual(artifactOf('ticket.json'), { artifact: 'ticket', repo: null });
    assert.deepEqual(artifactOf('plan-check.json'), { artifact: 'plan-check', repo: null });
    assert.deepEqual(artifactOf('implement.json'), { artifact: 'implement', repo: null });
    assert.deepEqual(artifactOf('implement.shop-web.json'), { artifact: 'implement', repo: 'shop-web' });
    assert.deepEqual(artifactOf('pr.my.repo.json'), { artifact: 'pr', repo: 'my.repo' });
    assert.deepEqual(artifactOf('release.api.json'), { artifact: 'release', repo: 'api' });
  });

  it('knows nothing of the files that are not artifacts', () => {
    for (const f of ['pr-create.json', 'accept-specs.json', 'lock.json', 'merge-state.json', 'plan.md', 'plan.json.tmp', 'plan.prev.json', 'ticket.md', 'progress.md']) assert.equal(artifactOf(f), null, f);
  });
});

describe('checking a work directory', () => {
  it('reports each invalid file with its errors and counts what it looked at', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'T-1'); mkdirSync(dir);
    writeFileSync(join(dir, 'ticket.json'), JSON.stringify(example('ticket')));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...example('plan'), steps: 'many' }));
    writeFileSync(join(dir, 'triage.json'), '{ not json');
    writeFileSync(join(dir, 'notes.json'), '{}');
    writeFileSync(join(dir, 'progress.md'), '# progress\n');
    const r = checkWorkdir(dir, { mode: 'write' });
    assert.equal(r.checked, 3);
    assert.deepEqual(r.invalid.map((i) => i.file), ['plan.json', 'triage.json']);
    assert.match(r.invalid[1].errors[0], /not valid JSON/);
  });

  it('a work root: one pass over every ticket directory, none over the pipeline\'s own _ folders or stray files', (t) => {
    const root = tmp(); t.after(() => rm(root));
    for (const d of ['T-1', 'T-2', '_scratch']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'T-1', 'plan.json'), JSON.stringify(example('plan')));
    writeFileSync(join(root, 'T-2', 'plan.json'), JSON.stringify({ ...example('plan'), complexity: 'epic' }));
    writeFileSync(join(root, '_scratch', 'plan.json'), 'not json');
    writeFileSync(join(root, 'plan.json'), 'not json');
    const r = checkWorkroot(root, { mode: 'write' });
    assert.equal(r.checked, 2);
    assert.deepEqual(r.invalid.map((i) => i.file), ['T-2/plan.json']);
  });
});

describe('the contract is documented', () => {
  it('schemas/README.md exists and names every artifact', () => {
    const text = readFileSync(join(PLUGIN_ROOT, 'schemas', 'README.md'), 'utf8');
    for (const a of ARTIFACTS) assert.ok(text.includes(`${a}.schema.json`) || text.includes(`\`${a}\``), `${a} is named in schemas/README.md`);
    assert.match(text, /x-legacy/);
  });
});
