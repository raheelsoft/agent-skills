// mergegate.mjs — the merge decision: an open P0/P1 can never merge, the person's word has an order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDecision } from '../lib/contract/mergegate.mjs';

const ok = { next: 'merge', open: { P0: 0, P1: 0, P2: 1 }, verdict: 'PASS WITH WARNINGS', mergeable: true, checks: 'pass' };

describe('mergeDecision', () => {
  it('a passing review with every fix-before-merging item resolved asks, or merges when told to', () => {
    assert.equal(mergeDecision(ok).action, 'ask');
    assert.equal(mergeDecision({ ...ok, merge: 'auto' }).action, 'merge');
    assert.match(mergeDecision({ ...ok, standing: 'auto' }).why, /\(standing\)/);
  });

  it('the invocation beats the standing instruction, which beats the default', () => {
    assert.equal(mergeDecision({ ...ok, merge: 'ask', standing: 'auto' }).action, 'ask');
    assert.equal(mergeDecision({ ...ok, merge: 'auto', standing: 'ask' }).action, 'merge');
    assert.equal(mergeDecision({ ...ok, standing: 'auto' }).action, 'merge');
  });

  it('an open P0 or P1 never merges, whatever the person said: fix while the loop has rounds, stop when it is over', () => {
    const blocked = { ...ok, open: { P0: 0, P1: 1 }, verdict: 'BLOCK', merge: 'auto' };
    assert.equal(mergeDecision({ ...blocked, next: 'fix' }).action, 'fix');
    assert.equal(mergeDecision({ ...blocked, next: 'merge' }).action, 'fix', 'even if the loop said merge, the open item says no');
    assert.equal(mergeDecision({ ...blocked, next: 'stop', why: 'budget spent' }).action, 'stop');
    assert.equal(mergeDecision({ ...ok, verdict: 'BLOCK', merge: 'auto' }).action, 'fix', 'a BLOCK verdict alone is enough');
  });

  it('the platform\'s word: not mergeable syncs, a failing check stops, a running one waits', () => {
    assert.equal(mergeDecision({ ...ok, mergeable: false, merge: 'auto' }).action, 'sync');
    assert.equal(mergeDecision({ ...ok, checks: 'fail', merge: 'auto' }).action, 'stop');
    assert.equal(mergeDecision({ ...ok, checks: 'pending', merge: 'auto' }).action, 'wait');
    assert.equal(mergeDecision({ ...ok, checks: 'none', mergeable: null, merge: 'auto' }).action, 'merge', 'no pipeline, no verdict from the platform: the review decides');
  });

  it('a loop that says stop or fix on a clean review is respected', () => {
    assert.equal(mergeDecision({ ...ok, next: 'stop' }).action, 'stop');
    assert.equal(mergeDecision({ ...ok, next: 'fix' }).action, 'fix');
  });
});
