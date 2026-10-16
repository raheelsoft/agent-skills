// approve.mjs — a plan's approval recorded in the one shape the pipeline reads.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, pickedUp, append, writeJson, ARTEFACTS } from './helpers.mjs';
import { approvePlan } from '../lib/state/approve.mjs';
import { computeState } from '../lib/state/compute.mjs';

/** A ticket planned, checked and waiting for the person's go-ahead. */
function waiting(t, { flags = [], check = { verdict: 'ok' }, plan = {} } = {}) {
  const root = tmp('approve-'); t.after(() => rm(root));
  const dir = pickedUp(root, { id: 'T-1' });
  ARTEFACTS.triage(dir, 'plan'); ARTEFACTS.plan(dir, { flags, ...plan }); ARTEFACTS.check(dir, check);
  append(dir, [['2026-01-01T11:00Z', 'triage', 'started'], ['2026-01-01T11:05Z', 'triage', 'done', 'plan'], ['2026-01-01T11:10Z', 'plan', 'started'], ['2026-01-01T11:20Z', 'plan', 'done', 'plan ready'], ['2026-01-01T11:21Z', 'plan-check', 'started'], ['2026-01-01T11:25Z', 'plan-check', 'done', 'ok']]);
  return dir;
}

describe('approvePlan', () => {
  it('writes the go-ahead line the state reads, and the ticket moves on to implement', (t) => {
    const dir = waiting(t, { flags: ['public-contract'] });
    assert.equal(computeState(dir).stopped?.stage, 'plan', 'waiting for the approval');
    const r = approvePlan(dir);
    assert.match(r.line, /^go-ahead: \d{4}-\d\d-\d\dT[\d:]+Z — round 1 — public-contract$/);
    assert.match(readFileSync(join(dir, 'answers.md'), 'utf8'), /^go-ahead: .* — round 1 — public-contract$/m);
    assert.equal(computeState(dir).stopped, null);
    assert.equal(computeState(dir).next, 'implement');
  });

  it('sets the check\'s override when it still said revise, and not otherwise', (t) => {
    const revise = waiting(t, { check: { schemaVersion: 1, verdict: 'revise', round: 1, override: null, findings: [] } });
    assert.equal(approvePlan(revise).override, true);
    assert.match(JSON.parse(readFileSync(join(revise, 'plan-check.json'), 'utf8')).override, /the person accepted/);
    assert.equal(approvePlan(waiting(t, { check: { schemaVersion: 1, verdict: 'ok', round: 1, override: null, findings: [] } })).override, false);
  });

  it('refuses a plan with open questions, and a ticket that is not waiting for an approval', (t) => {
    const open = waiting(t, { plan: { status: 'open-questions', openQuestions: 1 } });
    assert.throws(() => approvePlan(open), /not waiting for a plan approval|open questions/);
    const root = tmp('approve-'); t.after(() => rm(root));
    const fresh = pickedUp(root, { id: 'T-2' });
    assert.throws(() => approvePlan(fresh), /not waiting for a plan approval \(next: triage\)/);
  });

  it('records who answered when the office did', (t) => {
    const r = approvePlan(waiting(t), { by: 'office' });
    assert.match(r.line, / — from office$/);
  });
});
