// A review pass as data: the tier of a finding, the verdict, the PR comment and the pr.json row are derived, never written by the model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { script, tmp, rm } from './helpers.mjs';
import { SCHEMA_DIR } from '../lib/contract/index.mjs';
import { tierOf, verdictOf, idsOf, rowOf, renderReview, TIERS } from '../lib/contract/findings.mjs';

const example = () => JSON.parse(readFileSync(join(SCHEMA_DIR, 'examples', 'review-findings.json'), 'utf8'));
const pass = (findings, extra = {}) => ({ round: 1, sha: 'abc1234', mode: 'full', confidence: 4, findings, ...extra });
const f = (id, priority, extra = {}) => ({ id, priority, file: 'a.ts', line: id * 10, text: `finding ${id}`, fix: `fix ${id}`, ...extra });

describe('tierOf', () => {
  it('P0 and P1 gate the merge, P2 is should-fix, P3 and P4 could-improve', () => {
    assert.deepEqual(['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => tierOf(f(1, p))), ['fix', 'fix', 'should', 'could', 'could']);
  });

  it('a pre-existing defect, a noted one and a resolved one are their own tiers whatever their priority', () => {
    assert.equal(tierOf(f(1, 'P0', { scope: 'pre-existing' })), 'preexisting');
    assert.equal(tierOf(f(1, 'P1', { status: 'noted' })), 'noted');
    assert.equal(tierOf(f(1, 'P0', { status: 'resolved' })), 'resolved');
  });
});

describe('verdictOf', () => {
  it('no findings is PASS', () => assert.equal(verdictOf(pass([])), 'PASS'));

  it('an open P0 or P1 is BLOCK; a resolved one is not', () => {
    assert.equal(verdictOf(pass([f(1, 'P1')])), 'BLOCK');
    assert.equal(verdictOf(pass([f(1, 'P0'), f(2, 'P3')])), 'BLOCK');
    assert.equal(verdictOf(pass([f(1, 'P1', { status: 'resolved' })])), 'PASS');
  });

  it('any other open item of the diff is PASS WITH WARNINGS', () => {
    assert.equal(verdictOf(pass([f(1, 'P2')])), 'PASS WITH WARNINGS');
    assert.equal(verdictOf(pass([f(1, 'P4')])), 'PASS WITH WARNINGS');
  });

  it('a pre-existing defect and a noted item do not move the verdict', () => {
    assert.equal(verdictOf(pass([f(1, 'P0', { scope: 'pre-existing' })])), 'PASS');
    assert.equal(verdictOf(pass([f(1, 'P1', { status: 'noted' })], { mode: 'resolution' })), 'PASS');
  });

  it('a failed gate is BLOCK, however clean the findings', () => {
    assert.equal(verdictOf(pass([], { gates: [{ gate: 'tests', status: 'FAIL' }] })), 'BLOCK');
    assert.equal(verdictOf(pass([], { gates: [{ gate: 'tests', status: 'fail: 2 red' }] })), 'BLOCK');
    assert.equal(verdictOf(pass([], { gates: [{ gate: 'lint', status: 'PASS' }, { gate: 'e2e', status: 'SKIP' }] })), 'PASS');
  });
});

describe('ids and the pr.json row', () => {
  it('open = the fix-before-merging items still open; new = all of a full pass, only the marked ones of a later pass', () => {
    assert.deepEqual(idsOf(pass([f(1, 'P1'), f(2, 'P1', { status: 'resolved' }), f(3, 'P3')])), { open: [1], new: [1, 2, 3] });
    assert.deepEqual(idsOf(pass([f(1, 'P1'), f(2, 'P1', { new: true })], { mode: 'delta', round: 2 })), { open: [1, 2], new: [2] });
    assert.deepEqual(idsOf(pass([f(1, 'P3', { new: false })])), { open: [], new: [] });
  });

  it('rowOf is the shape pr.schema.json holds', () => {
    assert.deepEqual(rowOf(pass([f(1, 'P1')])), { round: 1, sha: 'abc1234', verdict: 'BLOCK', open: [1], new: [1] });
  });
});

describe('renderReview', () => {
  it('writes the review the skill describes, from the example', () => {
    assert.equal(renderReview(example()), `## Review Summary

**Verdict:** BLOCK
**Confidence:** 4/5

### Gates
| Gate  | Status | Notes |
|-------|--------|-------|
| lint | PASS |  |
| tests | PASS | 41 tests |

#### Fix before merging (1)
1. \`src/invoices/total.ts:27\` — VAT is rounded per line, the contract says on the total; a 3-line order is off by 0.01.
   → Sum the net lines, then round once

#### Could improve (1)
2. \`src/invoices/total.ts:12\` — totalWithVat and withVat compute the same thing.
   → Minor. Keep one and call it from both places. Your call.

#### Pre-existing (1)
3. \`src/invoices/format.ts:5\` — formatMoney hard-codes two decimals. — tracked as ACME-57

Reviewed: 3f9c2ab · round 1 · open: 1 · new: 1, 2, 3
`);
  });

  it('leaves out a tier with no items and the gates table when there are no gates', () => {
    const text = renderReview(pass([f(1, 'P2')]));
    assert.match(text, /#### Should fix \(1\)/);
    assert.doesNotMatch(text, /Fix before merging|Could improve|### Gates/);
    assert.match(text, /\*\*Verdict:\*\* PASS WITH WARNINGS/);
    assert.match(text, /→ fix 1\. Your call\.$/m);
  });

  it('a pre-existing item names its ticket, or says one is needed', () => {
    const text = renderReview(pass([f(1, 'P2', { scope: 'pre-existing', ticket: 'X-9' }), f(2, 'P2', { scope: 'pre-existing' })]));
    assert.match(text, /1\. `a\.ts:10` — finding 1 — tracked as X-9/);
    assert.match(text, /2\. `a\.ts:20` — finding 2 — ticket needed/);
  });

  it('a delta or resolution pass has no should-fix or could-improve section, and lists what was fixed', () => {
    const review = pass([f(1, 'P1', { status: 'resolved' }), f(2, 'P1'), f(3, 'P2', { new: true }), f(4, 'P3', { status: 'noted' })], { mode: 'resolution', round: 3 });
    const text = renderReview(review);
    assert.match(text, /#### Fix before merging \(1\)\n2\. /);
    assert.match(text, /#### Resolved \(1\)\n1\. `a\.ts:10` — finding 1 — resolved/);
    assert.match(text, /#### Noted, not gating \(1\)\n4\. /);
    assert.doesNotMatch(text, /Should fix|Could improve/);
    assert.match(text, /Reviewed: abc1234 · round 3 · open: 2 · new: 3$/m);
    assert.doesNotMatch(renderReview(pass([f(1, 'P2')], { mode: 'delta' })), /Should fix/);
  });

  it('no open item and none raised says none', () => {
    assert.match(renderReview(pass([])), /open: none · new: none$/m);
  });

  it('items stay in id order within a tier, and a finding with no line cites the file alone', () => {
    const text = renderReview(pass([f(3, 'P1', { line: null }), f(1, 'P1')]));
    assert.ok(text.indexOf('1. `a.ts:10`') < text.indexOf('3. `a.ts`'));
  });

  it('every tier the renderer knows is one the schema\'s priorities and scopes can reach', () => {
    assert.deepEqual(TIERS.map((t) => t.key), ['fix', 'should', 'could', 'resolved', 'preexisting', 'noted']);
  });
});

describe('findings.mjs — the command', () => {
  const FINDINGS = script('findings.mjs');
  const run = (...args) => { const r = spawnSync(process.execPath, [FINDINGS, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const file = (t, obj) => { const root = tmp(); t.after(() => rm(root)); const p = join(root, 'review.json'); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };

  it('verdict, render and row read the file; check says whether it is valid', (t) => {
    const p = file(t, example());
    assert.equal(run('verdict', p).out, 'BLOCK\n');
    assert.match(run('render', p).out, /^## Review Summary/);
    assert.deepEqual(JSON.parse(run('row', p).out), { round: 1, sha: '3f9c2ab', verdict: 'BLOCK', open: [1], new: [1, 2, 3] });
    assert.deepEqual(JSON.parse(run('check', p).out), { ok: true, errors: [] });
  });

  it('a file that does not match the schema is refused with the errors, by every subcommand', (t) => {
    const bad = example(); bad.findings[0].priority = 'P9';
    const p = file(t, bad);
    for (const cmd of ['verdict', 'render', 'row']) {
      const r = run(cmd, p);
      assert.equal(r.code, 1, cmd);
      assert.match(r.err, /\$\.findings\[0\]\.priority/);
    }
    const c = run('check', p);
    assert.equal(c.code, 1);
    assert.equal(JSON.parse(c.out).ok, false);
  });

  it('JSON that does not parse is exit 1; a missing file or an unknown command is exit 2', (t) => {
    assert.equal(run('verdict', file(t, '{ nope')).code, 1);
    assert.equal(run('verdict', '/no/such/file.json').code, 2);
    assert.equal(run('judge', file(t, '{}')).code, 2);
  });
});
