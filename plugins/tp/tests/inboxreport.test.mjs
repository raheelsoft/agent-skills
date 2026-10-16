// inboxreport.mjs — the inbox as the session's report: the stop's own words, shared numbering, the act tail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderInbox } from '../lib/state/inboxreport.mjs';

const item = (over) => ({ id: 'T-1', ticket: 'T-1', stage: 'triage', kind: 'question', question: 'which repo? api | web? Default: api', waitingMin: 30, default: 'api', resumable: false, resume: '/tp:run-ticket T-1 answers="…"', answer: null, lock: null, needs: null, ...over });

describe('renderInbox', () => {
  const items = [
    item({ id: 'Q-1', waitingMin: 42, stage: 'implement:api', question: 'step 3 — title too | body only? Default: body only' }),
    item({ id: 'Q-2', waitingMin: 130, kind: 'question' }),
    item({ id: 'A-1', waitingMin: 15, kind: 'approval', stage: 'plan', question: 'approval needed: 4 steps — approve (go-ahead) or send a change' }),
    item({ id: 'R-1', waitingMin: 5, resumable: true, stage: 'run-ticket', question: 'usage pause, reset 14:00 passed', resume: '/tp:run-ticket R-1' }),
    item({ id: 'S-1', waitingMin: 9, answer: { text: 'merge', by: 'office', queuedAt: '2026-10-16T10:12:00Z' }, stage: 'merge' }),
    item({ id: 'E-1', waitingMin: 70, kind: 'error', question: 'error: clone failed', needs: 'load the deploy key', resume: '/tp:run-ticket E-1 answers=retry' }),
    item({ id: 'P-1', kind: 'blocked', question: 'blocked by X-3 (In Progress)', waitingMin: 600 }),
    item({ id: 'L-1', lock: { owner: 'sess-2', since: '2026-10-16T09:40:00Z', stale: false } }),
  ];
  const r = renderInbox(items, { date: '2026-10-16', plan: 'starts A-9 once these are answered' });

  it('heads with the counts and lists the groups in order, only the non-empty ones', () => {
    const lines = r.text.split('\n');
    assert.equal(lines[0], 'inbox 2026-10-16: 8 open · 2 resume by themselves · 2 questions · 1 approvals · 1 errors · 1 parked · 0 problems');
    const heads = lines.filter((l) => /^[a-z].*:$/.test(l)).map((l) => l.split(' (')[0]);
    assert.deepEqual(heads, ['answers queued', 'resumes by itself', 'questions', 'approvals', 'errors', 'still parked', 'locks held elsewhere']);
  });

  it('keeps the stop\'s own wording, numbers questions and approvals together oldest first, and names a queued answer', () => {
    assert.match(r.text, /1\. Q-2 · triage · waiting 2h 10m · which repo\? api \| web\? Default: api/);
    assert.match(r.text, /2\. Q-1 · implement:api · waiting 42m · step 3 — title too \| body only\? Default: body only/);
    assert.match(r.text, /3\. A-1 · plan · waiting 15m · approval needed: 4 steps — approve \(go-ahead\) or send a change/);
    assert.match(r.text, /- S-1 · merge · answered "merge" from office 10:12 · \/tp:run-ticket S-1/);
    assert.match(r.text, /- E-1 · triage · error: clone failed · needs: load the deploy key · \/tp:run-ticket E-1 answers=retry/);
    assert.match(r.text, /- L-1 · locked by sess-2 since 09:40 \(live\)/);
  });

  it('ends with the day plan and the act tail', () => {
    assert.match(r.text, /day plan 2026-10-16: starts A-9 once these are answered/);
    assert.equal(r.act, 'act: run S-1 R-1 · ask 1 2 3 · retry E-1 · show P-1 L-1 · plan-day 2026-10-16');
  });

  it('a dry run says so and leaves no plan line; an empty inbox is one line and act: none', () => {
    const d = renderInbox(items, { date: 'd', dry: true });
    assert.match(d.text, /act: none — dry run$/); assert.doesNotMatch(d.text, /day plan/);
    const e = renderInbox([], { date: 'd' });
    assert.match(e.text, /^inbox d: 0 open/); assert.equal(e.act, 'act: none');
  });
});
