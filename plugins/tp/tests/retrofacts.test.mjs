// retrofacts.mjs — the numbers and quotes a retrospective needs, gathered by the script.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, pickedUp, append, writeJson } from './helpers.mjs';
import { answersOf, summaryOf, retroFacts } from '../lib/state/retrofacts.mjs';

const ANSWERS = `# Answers — T-1

## 2026-09-20T07:04:32Z — plan (round 1)

**Q:** approval needed: 5 steps — approve (go-ahead) or send a change
**A:** 1: go-ahead

go-ahead: 2026-09-20T07:04:32Z — round 1 — access-control

## 2026-09-20T09:52Z — merge (review loop stop)

**Q:** review loop: round 2 resolved nothing

**A:** fix reject impossible calendar days
`;
const PLAN = `# Plan

## Implementation summary
steps: 5/5   commits: df1d33e, 249b80e
deviations: none
gates: Types PASS | Lint PASS
manual steps:
1. x
`;

describe('retrofacts', () => {
  it('answersOf reads each section with its question and answer', () => {
    const a = answersOf(ANSWERS);
    assert.equal(a.length, 2);
    assert.deepEqual([a[0].at, a[0].stage, a[0].answer], ['2026-09-20T07:04:32Z', 'plan', '1: go-ahead']);
    assert.match(a[1].question, /resolved nothing/); assert.match(a[1].answer, /^fix reject/);
  });

  it('summaryOf reads the implementation summary', () => {
    assert.deepEqual(summaryOf(PLAN), { steps: { done: 5, total: 5 }, commits: 'df1d33e, 249b80e', deviations: 'none', gates: 'Types PASS | Lint PASS' });
    assert.equal(summaryOf('# Plan\n'), null);
  });

  it('gathers stops, answers, manual criteria, estimate against actual and the counts', (t) => {
    const root = tmp('retro-'); t.after(() => rm(root));
    const dir = pickedUp(root, { id: 'T-1', extra: { estimate: { source: 'pipeline', focusedHours: 8 }, actual: { focusedHours: 6, source: 'person', at: 'x', by: 'eod' } } });
    append(dir, [['2026-01-01T11:00Z', 'triage', 'started'], ['2026-01-01T11:05Z', 'triage', 'stopped', 'which env? Default: stage'], ['2026-01-01T11:30Z', 'triage', 'started']]);
    writeFileSync(join(dir, 'answers.md'), ANSWERS); writeFileSync(join(dir, 'plan.md'), PLAN);
    writeJson(dir, 'accept.json', { where: 'checkout', targets: [], criteria: [{ n: 1, text: 'a', result: 'pass', evidence: 'e' }, { n: 2, text: 'b', result: 'manual', evidence: 'steps' }], passed: 1, failed: 0, manual: 1 });
    const f = retroFacts(dir, { claudeDir: join(root) });
    assert.deepEqual(f.counts, { questions: 2, manualCriteria: 1, stops: 1 });
    assert.match(f.stops[0], /which env\? Default: stage/);
    assert.deepEqual(f.manualCriteria, [{ n: 2, text: 'b' }]);
    assert.equal(f.actualOverEstimate, 0.75);
    assert.equal(f.summary.deviations, 'none');
  });

  it('refuses a path that is not a work directory', () => {
    assert.throws(() => retroFacts('/no/such/dir'), /is not a directory/);
  });
});
