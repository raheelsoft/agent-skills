// reviewnext.mjs — record a review pass, ask the loop, decide the merge, in one call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmp, rm, pickedUp, ARTEFACTS } from './helpers.mjs';
import { reviewNext, reviewNextArgs } from '../lib/state/reviewnext.mjs';

const finding = (id, priority, extra = {}) => ({ id, priority, file: 'a.ts', line: id, text: `t${id}`, fix: `f${id}`, ...extra });
const pass = (round, findings, extra = {}) => ({ round, sha: `sha${round}`, mode: round === 1 ? 'full' : 'delta', confidence: 4, findings, ...extra });

function ticketWithPr(t) {
  const root = tmp('reviewnext-'); t.after(() => rm(root));
  const dir = pickedUp(root, { id: 'T-1' });
  ARTEFACTS.pr(dir, null, { merged: null, reviews: [], reviewRounds: 0, verdict: null });
  return dir;
}

describe('reviewNext', () => {
  it('a clean first pass merges under merge=auto and asks otherwise; the pass is recorded', (t) => {
    const dir = ticketWithPr(t);
    const r = reviewNext(dir, pass(1, []), { rating: 'low', files: 2, lines: 20, merge: 'auto' });
    assert.equal(r.row.verdict, 'PASS');
    assert.deepEqual([r.rounds.next, r.decision.action], ['merge', 'merge']);
    const again = reviewNext(ticketWithPr(t), pass(1, []), { rating: 'low' });
    assert.equal(again.decision.action, 'ask');
  });

  it('an open P1 is a fix while the budget lasts, and never a merge even with merge=auto', (t) => {
    const dir = ticketWithPr(t);
    const r = reviewNext(dir, pass(1, [finding(1, 'P1')]), { rating: 'medium', merge: 'auto' });
    assert.equal(r.row.verdict, 'BLOCK');
    assert.deepEqual([r.rounds.next, r.decision.action], ['review', 'fix']);
  });

  it('when the budget is spent with the item still open, the decision is stop', (t) => {
    const dir = ticketWithPr(t);
    reviewNext(dir, pass(1, [finding(1, 'P1')]), { rating: 'low' });
    const r = reviewNext(dir, pass(2, [finding(1, 'P1', { new: false })]), { rating: 'low', merge: 'auto' });
    assert.equal(r.rounds.next, 'stop'); assert.equal(r.decision.action, 'stop');
  });

  it('the platform\'s report is passed in: not mergeable syncs', (t) => {
    const r = reviewNext(ticketWithPr(t), pass(1, []), { rating: 'low', merge: 'auto', mergeable: false });
    assert.equal(r.decision.action, 'sync');
  });

  it('reviewNextArgs reads the flags', () => {
    assert.deepEqual(reviewNextArgs(['--rating', 'low', '--files', '3', '--lines', '40', '--merge', 'auto', '--mergeable', 'false', '--checks', 'pending', '--repo', 'api']),
      { repo: 'api', rating: 'low', files: 3, lines: 40, claudeDir: undefined, merge: 'auto', standing: null, checks: 'pending', mergeable: false });
  });
});

describe('findings.mjs next, through the command line', () => {
  it('records the pass and prints the decision', async (t) => {
    const { spawnSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const { script } = await import('./helpers.mjs');
    const dir = ticketWithPr(t);
    const f = join(dir, 'review.json'); writeFileSync(f, JSON.stringify(pass(1, [])));
    const r = spawnSync(process.execPath, [script('findings.mjs'), 'next', f, dir, '--rating', 'low', '--merge', 'auto'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.row.verdict, out.rounds.next, out.decision.action], ['PASS', 'merge', 'merge']);
  });
});
