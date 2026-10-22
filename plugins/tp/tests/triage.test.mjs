// triage.mjs — the rubric as a function: the same evidence, the same decision.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../lib/model/triage.mjs';

const SMALL = { criteria: 'clear', files: 2, areas: 1, pattern: 'adjacent' };

describe('triage', () => {
  it('clear criteria, a few files in one area with a pattern beside them, no risk row: direct, low or medium', () => {
    const r = triage(SMALL);
    assert.equal(r.decision, 'direct'); assert.equal(r.complexity, 'medium');
    assert.equal(triage({ ...SMALL, files: 1 }).complexity, 'low');
  });

  it('any risk row, more than five files, a second area or repo, or no pattern makes it a plan, and high where the rubric says so', () => {
    assert.deepEqual([triage({ ...SMALL, dataModel: true }).decision, triage({ ...SMALL, dataModel: true }).complexity], ['plan', 'high']);
    assert.equal(triage({ ...SMALL, files: 6 }).decision, 'plan');
    assert.equal(triage({ ...SMALL, areas: 2 }).decision, 'plan');
    assert.equal(triage({ ...SMALL, repos: 2 }).decision, 'plan');
    const nopat = triage({ ...SMALL, pattern: 'none' });
    assert.deepEqual([nopat.decision, nopat.complexity], ['plan', 'high']);
    assert.equal(triage({ ...SMALL, access: true }).complexity, 'high');
    assert.equal(triage({ ...SMALL, irreversible: true }).decision, 'plan');
  });

  it('missing or contradicting criteria, an epic, a stakeholder question or an unlocatable area need input, whatever else holds', () => {
    for (const e of [{ criteria: 'missing' }, { criteria: 'contradict' }, { epic: true }, { questions: 'stakeholder' }, { files: null }]) {
      assert.equal(triage({ ...SMALL, ...e }).decision, 'needs-input', JSON.stringify(e));
    }
    assert.equal(triage({ ...SMALL, criteria: 'missing', dataModel: true }).decision, 'needs-input');
  });

  it('partial criteria and planner-answerable questions are a plan; derived criteria and open questions rate high', () => {
    assert.deepEqual([triage({ ...SMALL, criteria: 'partial' }).decision, triage({ ...SMALL, criteria: 'partial' }).complexity], ['plan', 'medium']);
    assert.equal(triage({ ...SMALL, questions: 'planner' }).decision, 'plan');
    assert.equal(triage({ ...SMALL, questions: 'planner' }).complexity, 'high');
    assert.equal(triage({ ...SMALL, derived: true }).complexity, 'high');
  });

  it('uncertain is one level up, and a pattern elsewhere in the repo is medium novelty', () => {
    assert.equal(triage({ ...SMALL, files: 1, uncertain: true }).complexity, 'medium');
    assert.equal(triage({ ...SMALL, files: 1, pattern: 'elsewhere' }).complexity, 'medium');
    assert.equal(triage({ ...SMALL, files: 1, pattern: 'elsewhere', uncertain: true }).complexity, 'high');
  });

  it('says why: the columns and the reasons that decided', () => {
    const r = triage({ ...SMALL, files: 7, contract: true });
    assert.deepEqual(r.columns, { scope: 'high', ambiguity: 'low', risk: 'high', novelty: 'low' });
    assert.deepEqual(r.why, ['7 files', 'public contract']);
  });
});
