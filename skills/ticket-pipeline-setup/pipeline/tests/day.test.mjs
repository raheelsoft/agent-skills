// day.mjs — the day planner's arithmetic: selection, ordering, lanes, advancing a day.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, rm, day, writeJson, touch, pickedUp, append, ARTEFACTS, STATE } from './helpers.mjs';

const DATE = '2026-09-19';
const T = (id, extra = {}) => ({ id, hours: 1, ...extra }); // an hour each unless a test says otherwise — the day model is tested on its own
const ids = (list) => list.map((t) => t.id);

/** A work root (<root>/work) with an optional tiers.json beside it. */
function root(tiers) {
  const r = tmp('day-test-');
  mkdirSync(join(r, 'work'));
  if (tiers) writeJson(r, 'tiers.json', tiers);
  return r;
}
/** A ticket whose pipeline reached `upTo` (a stage name) — rows and artefacts as the stages leave them. */
function reached(r, id, upTo, stop = null) {
  const dir = pickedUp(r, { id });
  const seq = [
    ['triage', () => ARTEFACTS.triage(dir)],
    ['implement', () => ARTEFACTS.implement(dir)],
    ['create-pr', () => ARTEFACTS.pr(dir, null, { merged: null })],
    ['merge', () => ARTEFACTS.pr(dir)],
    ['release', () => ARTEFACTS.release(dir)],
    ['accept', () => ARTEFACTS.accept(dir)],
  ];
  let minute = 10;
  for (const [stage, artefacts] of seq) {
    if (stage === stop) { append(dir, [[`2026-01-01T10:${minute}Z`, stage, 'started'], [`2026-01-01T10:${minute + 1}Z`, stage, 'stopped', 'which way?']]); return dir; }
    artefacts();
    append(dir, [[`2026-01-01T10:${minute}Z`, stage, 'started'], [`2026-01-01T10:${minute + 1}Z`, stage, 'done', 'x']]);
    minute += 2;
    if (stage === upTo) break;
  }
  return dir;
}
const planOf = (r, input) => day('plan', join(r, 'work'), JSON.stringify({ date: DATE, ...input }));
const advanceOf = (r, input = {}) => day('advance', join(r, 'work'), DATE, JSON.stringify(input));

describe('day.mjs plan', () => {
  let r;
  before(() => { r = root(); });
  after(() => rm(r));

  it('sprint: keeps every unblocked candidate, orders by dependency, fills the free lanes, writes the plan', () => {
    const p = planOf(r, { from: 'sprint', lanes: 2, tickets: [T('T-3', { after: ['T-1'] }), T('T-1'), T('T-2')] });
    assert.equal(p.code, 0, p.stderr);
    assert.deepEqual(p.json.batches, [['T-1', 'T-2'], ['T-3']]);
    assert.deepEqual(p.json.start, ['T-1', 'T-2']);
    assert.deepEqual(p.json.tickets.map((t) => [t.id, t.status]), [['T-1', 'starting'], ['T-2', 'starting'], ['T-3', 'queued']]);
    assert.deepEqual(p.json.waiting, [{ id: 'T-3', on: [{ id: 'T-1', status: 'starting' }] }]);
    assert.ok(p.json.tickets[0].startedAt && !p.json.tickets[2].startedAt);
    assert.ok(existsSync(join(r, 'work', '_day', `${DATE}.json`)) && existsSync(join(r, 'work', '_day', `${DATE}.md`)));
    assert.match(readFileSync(join(r, 'work', '_day', `${DATE}.md`), 'utf8'), /Batches: T-1 \+ T-2 → T-3/);
    const shown = day('show', join(r, 'work'), DATE);
    assert.deepEqual(shown.json.tickets.map((t) => t.id), ['T-1', 'T-2', 'T-3']);
  });

  it('skips blocked and soft-blocked tickets and whatever waits on them or on an unknown id', () => {
    const p = planOf(r, { from: 'sprint', lanes: 3, tickets: [
      T('T-1'), T('T-5', { blocked: 'T-8 in progress' }), T('T-6', { after: ['T-5'] }), T('T-4', { after: ['T-9'] }), T('T-7', { soft: 'T-2 merged, status stale' }),
    ] });
    assert.equal(p.code, 0, p.stderr);
    assert.deepEqual(ids(p.json.tickets), ['T-1']);
    assert.deepEqual(Object.fromEntries(p.json.skipped.map((s) => [s.id, s.why])), {
      'T-5': 'blocked: T-8 in progress',
      'T-6': 'waits on T-5 (blocked: T-8 in progress)',
      'T-4': "waits on T-9 (not in today's candidates)",
      'T-7': 'soft-blocked: T-2 merged, status stale',
    });
  });

  it('a prerequisite already done in a work directory is satisfied; one in flight is listed and waited on', () => {
    const r2 = root();
    reached(r2, 'T-1', 'accept');
    reached(r2, 'T-8', 'implement');
    const p = planOf(r2, { from: 'sprint', lanes: 3, tickets: [T('T-1'), T('T-2', { after: ['T-1'] }), T('T-3', { after: ['T-8'] }), T('T-8')] });
    assert.equal(p.code, 0, p.stderr);
    assert.deepEqual(p.json.skipped, [{ id: 'T-1', why: 'already done (its work directory is complete)' }]);
    assert.deepEqual(p.json.inFlight.map((i) => [i.id, i.status, i.stage]), [['T-8', 'in-progress', 'create-pr']]);
    assert.deepEqual(p.json.start, ['T-2']);
    assert.deepEqual(p.json.waiting, [{ id: 'T-3', on: [{ id: 'T-8', status: 'in-progress' }] }]);
    rm(r2);
  });

  it('pool: draws with the date as the seed — the same day draws the same tickets, another day another order', () => {
    const tickets = Array.from({ length: 12 }, (_, i) => T(`T-${i + 1}`));
    const a = planOf(r, { from: 'pool', lanes: 2, count: 4, tickets });
    const b = planOf(r, { from: 'pool', lanes: 2, count: 4, tickets });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.json.tickets.length, 4);
    assert.deepEqual(ids(a.json.tickets), ids(b.json.tickets));
    assert.equal(a.json.undrawn.length, 8);
    const r2 = root(); // a fresh root: an earlier day's plan would otherwise carry its order over
    const c = day('plan', join(r2, 'work'), JSON.stringify({ date: '2026-09-20', from: 'pool', lanes: 2, count: 4, tickets }));
    assert.notDeepEqual(ids(c.json.tickets).concat(c.json.undrawn), ids(a.json.tickets).concat(a.json.undrawn));
    rm(r2);
    assert.deepEqual(a.json.start, ids(a.json.tickets).slice(0, 2));
  });

  it('pool: a dependent is drawn only with its prerequisites, within the count', () => {
    const tickets = [T('X'), T('Y', { after: ['X'] }), T('Z', { after: ['X'] })];
    const one = planOf(r, { from: 'pool', lanes: 1, count: 1, tickets });
    assert.deepEqual(ids(one.json.tickets), ['X']);
    assert.deepEqual(one.json.undrawn, ['Y', 'Z']);
    const two = planOf(r, { from: 'pool', lanes: 1, count: 2, tickets });
    assert.equal(two.json.tickets.length, 2);
    assert.equal(two.json.tickets[0].id, 'X');
  });

  it('pool: the default count is tiers.json.day.draw (6 unless set)', () => {
    const r2 = root({ day: { lanes: { ample: 2 }, draw: 3 } });
    const tickets = Array.from({ length: 10 }, (_, i) => T(`T-${i + 1}`));
    const p = planOf(r2, { from: 'pool', band: 'ample', claudeDir: r2, tickets });
    assert.equal(p.json.count, 3);
    assert.equal(p.json.tickets.length, 3);
    assert.equal(p.json.lanes, 2);
    const l = day('lanes', 'economy', r2);
    assert.deepEqual([l.json.band, l.json.lanes, l.json.draw, l.json.count, l.json.day.perDay], ['economy', 1, 3, 3, 5.2]);
    const r3 = root();
    const d = planOf(r3, { from: 'pool', tickets });
    assert.deepEqual([d.json.count, d.json.tickets.length], [6, 6]);
    rm(r2); rm(r3);
  });

  it('by default every ready ticket starts in parallel — no lane cap unless the usage band sets one', () => {
    const r2 = root();
    const tickets = [T('T-1'), T('T-2'), T('T-3', { after: ['T-1'] }), T('T-4'), T('T-5', { after: ['T-4', 'T-2'] })];
    const p = planOf(r2, { from: 'sprint', dry: true, tickets });
    assert.equal(p.json.lanes, 'all');
    assert.deepEqual(p.json.start, ['T-1', 'T-2', 'T-4'], 'every unblocked, independent ticket at once');
    assert.deepEqual(p.json.waiting.map((w) => w.id), ['T-3', 'T-5'], 'dependents wait for their prerequisites');
    assert.match(p.json.why, /starting every ready ticket in parallel — T-1, T-2, T-4/);
    const ample = planOf(r2, { from: 'sprint', band: 'ample', dry: true, tickets });
    assert.deepEqual([ample.json.lanes, ample.json.start], ['all', ['T-1', 'T-2', 'T-4']]);
    const unknown = day('lanes', 'unknown', r2);
    assert.deepEqual([unknown.json.lanes, day('lanes', 'ample', r2).json.lanes, day('lanes', 'economy', r2).json.lanes, day('lanes', 'stop', r2).json.lanes], ['all', 'all', 1, 0]);
    const explicit = planOf(r2, { from: 'sprint', lanes: 'all', band: 'economy', dry: true, tickets });
    assert.deepEqual([explicit.json.lanes, explicit.json.start.length], ['all', 3], 'lanes=all given wins over the band');
    const capped = planOf(r2, { from: 'sprint', lanes: 2, dry: true, tickets });
    assert.deepEqual(capped.json.start, ['T-1', 'T-2']);
    rm(r2);
  });

  it('sprint with count: highest priority first, each with its prerequisites', () => {
    const p = planOf(r, { from: 'sprint', lanes: 3, count: 2, tickets: [T('T-1', { priority: 3 }), T('T-2', { priority: 1, after: ['T-1'] }), T('T-3', { priority: 2 })] });
    assert.deepEqual(ids(p.json.tickets), ['T-1', 'T-2']);
    assert.deepEqual(p.json.undrawn, ['T-3']);
  });

  it('a dependency cycle is an error naming the cycle', () => {
    const p = planOf(r, { from: 'sprint', lanes: 1, tickets: [T('A', { after: ['B'] }), T('B', { after: ['A'] }), T('C')] });
    assert.equal(p.code, 1);
    assert.deepEqual(p.json.cycle, ['A', 'B']);
  });

  it('lanes follow the budget band through tiers.json.day; stop starts nothing', () => {
    const r2 = root({ day: { lanes: { ample: 2 } } });
    const tickets = [T('T-1'), T('T-2'), T('T-3')];
    const ample = planOf(r2, { from: 'sprint', band: 'ample', claudeDir: r2, dry: true, tickets });
    assert.deepEqual([ample.json.lanes, ample.json.start], [2, ['T-1', 'T-2']]);
    const stop = planOf(r2, { from: 'sprint', band: 'stop', claudeDir: r2, dry: true, tickets });
    assert.deepEqual([stop.json.lanes, stop.json.start], [0, []]);
    assert.match(stop.json.why, /no lanes \(usage band stop\)/);
    const economy = planOf(r2, { from: 'sprint', band: 'economy', tickets });
    assert.deepEqual([economy.json.lanes, economy.json.start], [1, ['T-1']]);
    rm(r2);
  });

  it('an advance re-resolves the lanes: a stale stored number gives way to the band or the default, a person\'s lanes= stands', () => {
    const r2 = root();
    const tickets = [T('T-1'), T('T-2'), T('T-3')];
    // a plan an older planner wrote: band unknown, lanes 1 stored from its defaults, nothing given
    planOf(r2, { from: 'sprint', dry: true, tickets });
    const file = join(r2, 'work', '_day', `${DATE}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    writeJson(join(r2, 'work', '_day'), `${DATE}.json`, { ...stored, lanes: 1, band: 'unknown', lanesGiven: undefined });
    let a = advanceOf(r2, { dry: true });
    assert.deepEqual([a.json.lanes, a.json.start], ['all', ['T-1', 'T-2', 'T-3']], 'the stored 1 is re-resolved through tiers.json → all');
    a = advanceOf(r2, { band: 'economy' });
    assert.deepEqual([a.json.lanes, a.json.start], [1, ['T-1']], 'a tight band still caps');
    a = advanceOf(r2, { dry: true });
    assert.deepEqual(a.json.lanes, 1, 'and the last reading stands until a new one');
    // the person's own choice is kept across advances
    planOf(r2, { from: 'sprint', lanes: 2, dry: true, tickets });
    a = advanceOf(r2, { dry: true, band: 'ample' });
    assert.deepEqual([a.json.lanes, a.json.lanesGiven, a.json.start], [2, true, ['T-2']], 'T-1 already started above: one of two lanes free');
    const st = day('status', join(r2, 'work'), DATE);
    assert.equal(st.json.lanes, 2, 'status shows the same');
    rm(r2);
  });

  it('dry: computes start without marking anything started', () => {
    const r2 = root();
    const p = planOf(r2, { from: 'sprint', lanes: 2, dry: true, tickets: [T('T-1'), T('T-2')] });
    assert.deepEqual(p.json.start, ['T-1', 'T-2']);
    assert.deepEqual(p.json.tickets.map((t) => [t.status, t.startedAt]), [['queued', null], ['queued', null]]);
    assert.deepEqual(p.json.running, []);
    rm(r2);
  });

  it('a re-plan keeps the launch stamps of tickets it already started', () => {
    const r2 = root();
    const first = planOf(r2, { from: 'sprint', lanes: 1, tickets: [T('T-1'), T('T-2')] });
    const again = planOf(r2, { from: 'sprint', lanes: 1, tickets: [T('T-1'), T('T-2'), T('T-3')] });
    assert.equal(again.json.tickets.find((t) => t.id === 'T-1').startedAt, first.json.tickets[0].startedAt);
    assert.deepEqual(again.json.start, []); // the one lane is still T-1's
    rm(r2);
  });

  it("the previous day's unfinished tickets come first the next day", () => {
    const r2 = root();
    planOf(r2, { date: '2026-09-21', from: 'pool', lanes: 1, count: 3, tickets: [T('T-1'), T('T-2'), T('T-3'), T('T-4'), T('T-5')] });
    const first = day('show', join(r2, 'work'), '2026-09-21').json;
    const next = day('plan', join(r2, 'work'), JSON.stringify({ date: '2026-09-22', from: 'pool', lanes: 1, count: 3, tickets: [T('T-1'), T('T-2'), T('T-3'), T('T-4'), T('T-5')] })).json;
    assert.deepEqual(next.carried, ids(first.tickets));
    assert.deepEqual(ids(next.tickets), ids(first.tickets));
    rm(r2);
  });

  it('rejects bad input', () => {
    assert.equal(planOf(r, { from: 'weekly', tickets: [] }).code, 2);
    assert.equal(planOf(r, { from: 'pool', tickets: [T('A'), T('A')] }).code, 2);
    assert.equal(day('plan', join(r, 'work'), JSON.stringify({ date: 'today', from: 'pool', tickets: [] })).code, 2);
    assert.equal(day('show', join(r, 'work'), '1999-01-01').code, 2);
  });
});

describe('day.mjs advance', () => {
  let r;
  before(() => { r = root(); });
  after(() => rm(r));

  it('refreshes statuses from the work directories and starts the next ready ticket when a lane frees', () => {
    const p = planOf(r, { from: 'sprint', lanes: 1, tickets: [T('T-1'), T('T-2', { after: ['T-1'] }), T('T-3')] });
    assert.deepEqual(p.json.start, ['T-1']);
    let a = advanceOf(r);
    assert.deepEqual([a.json.start, a.json.why.startsWith('all 1 lane busy')], [[], true]);
    reached(r, 'T-1', 'accept');
    a = advanceOf(r);
    assert.deepEqual(a.json.done, ['T-1']);
    assert.deepEqual(a.json.start, ['T-3']); // plan order: the independent ticket was queued before the dependent
    assert.deepEqual(a.json.waiting, []);
    assert.equal(a.json.tickets.find((t) => t.id === 'T-1').endedAt !== null, true);
    reached(r, 'T-3', 'accept');
    a = advanceOf(r);
    assert.deepEqual([a.json.done, a.json.start], [['T-1', 'T-3'], ['T-2']]);
  });

  it('a dependent waits until its prerequisite is past merge — past create-pr when the project stacks', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2', { after: ['T-1'] })] });
    reached(r2, 'T-1', 'implement');
    let a = advanceOf(r2);
    assert.deepEqual([a.json.start, a.json.waiting], [[], [{ id: 'T-2', on: [{ id: 'T-1', status: 'running' }] }]]);
    reached(r2, 'T-1', 'create-pr');
    assert.deepEqual(advanceOf(r2).json.start, []);
    assert.deepEqual(advanceOf(r2, { stackable: true }).json.start, ['T-2']);
    const r3 = root();
    planOf(r3, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2', { after: ['T-1'] })] });
    reached(r3, 'T-1', 'merge');
    a = advanceOf(r3);
    assert.deepEqual(a.json.start, ['T-2']);
    assert.equal(a.json.tickets[0].status, 'running');
    rm(r2); rm(r3);
  });

  it('a stopped prerequisite holds its dependents and is reported with its question', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2', { after: ['T-1'] })] });
    reached(r2, 'T-1', 'implement', 'implement');
    const a = advanceOf(r2);
    assert.deepEqual(a.json.stopped, [{ id: 'T-1', stage: 'implement', question: 'which way?' }]);
    assert.deepEqual(a.json.waiting, [{ id: 'T-2', on: [{ id: 'T-1', status: 'stopped' }] }]);
    assert.deepEqual(a.json.start, []);
    assert.equal(a.json.finished, false);
    rm(r2);
  });

  it('a launched ticket with no work directory after 30 minutes is failed; its lane goes to the next', () => {
    const r2 = root();
    const t0 = '2026-09-19T08:00:00Z';
    planOf(r2, { from: 'sprint', lanes: 1, now: t0, tickets: [T('T-1'), T('T-2')] });
    let a = advanceOf(r2, { now: '2026-09-19T08:20:00Z' });
    assert.deepEqual([a.json.start, a.json.failed], [[], []]);
    a = advanceOf(r2, { now: '2026-09-19T08:31:00Z' });
    assert.deepEqual(a.json.failed.map((f) => f.id), ['T-1']);
    assert.match(a.json.failed[0].note, /no work directory/);
    assert.deepEqual(a.json.start, ['T-2']);
    rm(r2);
  });

  it('a closed ticket is terminal: never a satisfied prerequisite, skipped as a candidate', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2', { after: ['T-1'] })] });
    const d = pickedUp(r2, { id: 'T-1' });
    writeJson(d, 'triage.json', { decision: 'close', confidence: 'high', override: null, flags: [], questions: [], why: 'superseded by T-9' }); touch(d, 'triage.md');
    append(d, [['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'done', 'close (high) - low']]);
    const a = advanceOf(r2);
    assert.deepEqual(a.json.closed, [{ id: 'T-1', why: 'superseded by T-9' }]);
    assert.deepEqual(a.json.waiting, [{ id: 'T-2', on: [{ id: 'T-1', status: 'closed' }] }]);
    assert.deepEqual([a.json.start, a.json.finished], [[], false]);
    const p = day('plan', join(r2, 'work'), JSON.stringify({ date: '2026-09-20', from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-3', { after: ['T-1'] })] }));
    assert.deepEqual(p.json.skipped.map((s) => [s.id, s.why]), [['T-1', 'closed: superseded by T-9'], ['T-3', 'waits on T-1 (closed: superseded by T-9)']]);
    rm(r2);
  });

  it('finished once every ticket is done', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2')] });
    reached(r2, 'T-1', 'accept'); reached(r2, 'T-2', 'accept');
    const a = advanceOf(r2);
    assert.deepEqual([a.json.finished, a.json.done, a.json.why], [true, ['T-1', 'T-2'], "the day's plan is complete"]);
    rm(r2);
  });

  it('re-reads the lanes from a new band and keeps them otherwise', () => {
    const r2 = root({ day: { lanes: { ample: 3, economy: 1 } } });
    planOf(r2, { from: 'sprint', band: 'ample', claudeDir: r2, dry: true, tickets: [T('T-1'), T('T-2'), T('T-3')] });
    assert.deepEqual(advanceOf(r2, { band: 'economy', claudeDir: r2 }).json.start, ['T-1']);
    assert.deepEqual(advanceOf(r2, { dry: true }).json.lanes, 1);
    rm(r2);
  });

  it('a dry advance reads the work directories and writes nothing', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 1, tickets: [T('T-1'), T('T-2')] });
    const file = join(r2, 'work', '_day', `${DATE}.json`);
    const before = readFileSync(file, 'utf8');
    reached(r2, 'T-1', 'accept');
    const a = advanceOf(r2, { dry: true });
    assert.deepEqual([a.json.done, a.json.start], [['T-1'], ['T-2']]);
    assert.equal(readFileSync(file, 'utf8'), before, 'a dry advance never touches the plan file');
    assert.equal(advanceOf(r2, { dry: true }).json.start[0], 'T-2', 'nothing was marked started');
    rm(r2);
  });

  it('status is a dry advance of the latest plan that never writes and flags an old plan stale', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 1, tickets: [T('T-1'), T('T-2')] });
    const file = join(r2, 'work', '_day', `${DATE}.json`);
    const before = readFileSync(file, 'utf8');
    reached(r2, 'T-1', 'accept');
    let s = day('status', join(r2, 'work'), DATE);
    assert.deepEqual([s.json.date, s.json.done, s.json.start, s.json.stale], [DATE, ['T-1'], ['T-2'], true]);
    assert.equal(readFileSync(file, 'utf8'), before);
    s = day('status', join(r2, 'work')); // no date: the latest plan on or before today
    assert.equal(s.json.date, DATE);
    assert.equal(day('status', join(r2, 'work'), '2020-01-01').code, 2, 'no such plan');
    rm(r2);
  });
});

describe('day.mjs — blocker watching: skipped-blocked candidates come back once their blockers land', () => {
  it('a skipped-blocked candidate keeps what the plan needs to schedule it later', () => {
    const r = root();
    const p = planOf(r, { from: 'sprint', lanes: 2, tickets: [T('T-1'), T('T-2', { blocked: 'T-9 (In Progress)', blockedBy: ['T-9'], rating: 'medium', priority: 2, hours: 3 })] }).json;
    const sk = p.skipped.find((x) => x.id === 'T-2');
    assert.deepEqual([sk.why, sk.blockedBy.map((b) => [b.id, b.resolved]), sk.candidate.hours, sk.candidate.rating, sk.candidate.priority], ['blocked: T-9 (In Progress)', [['T-9', false]], 3, 'medium', 2]);
    rm(r);
  });

  it('advance with a re-check records the blockers, re-queues what is unblocked and leaves the rest skipped', () => {
    const r = root();
    planOf(r, { from: 'sprint', lanes: 1, tickets: [T('T-1', { hours: 2 }), T('T-2', { blocked: 'T-9', blockedBy: ['T-9'], hours: 2 }), T('T-3', { blocked: 'T-8', blockedBy: ['T-8'], hours: 1 })] });
    const a = advanceOf(r, { recheck: { 'T-2': [{ id: 'T-9', state: 'Done', resolved: true }], 'T-3': [{ id: 'T-8', state: 'In Review', resolved: false }] } });
    assert.deepEqual(a.json.unblocked, ['T-2']);
    assert.deepEqual(a.json.tickets.map((t) => [t.id, t.status]), [['T-1', 'starting'], ['T-2', 'queued']]);
    assert.match(a.json.tickets[1].note, /^unblocked \d{4}-/);
    assert.deepEqual(a.json.skipped.map((x) => [x.id, x.why]), [['T-3', 'blocked: T-8 In Review']]);
    assert.equal(a.json.skipped[0].blockedBy[0].checkedAt.length > 0, true);
    assert.deepEqual(a.json.days.map((d) => d.tickets.map((t) => t.id)), [['T-1', 'T-2']], 'the re-queued ticket is scheduled behind the plan');
    assert.deepEqual(a.json.batches, [['T-1', 'T-2']]);
    // the plan on disk carries it: the next advance starts it when the lane frees
    reached(r, 'T-1', 'accept');
    assert.deepEqual(advanceOf(r).json.start, ['T-2']);
    // soft-only blockers unblock too; a re-check of a ticket that is not skipped is ignored
    const r2 = root();
    planOf(r2, { from: 'sprint', lanes: 1, tickets: [T('T-4', { blocked: 'T-7', blockedBy: ['T-7'] })] });
    const b = advanceOf(r2, { recheck: { 'T-4': [{ id: 'T-7', state: 'In Review', resolved: false, soft: true }], 'T-1': [{ id: 'x', resolved: true }] } });
    assert.deepEqual([b.json.unblocked, b.json.start], [['T-4'], ['T-4']]);
    rm(r); rm(r2);
  });

  it('a re-queued dependent keeps its after edges to planned tickets and drops the rest', () => {
    const r = root();
    planOf(r, { from: 'sprint', lanes: 3, tickets: [T('T-1'), T('T-2', { blocked: 'T-9', blockedBy: ['T-9'], after: ['T-1', 'T-9'] })] });
    const a = advanceOf(r, { recheck: { 'T-2': [{ id: 'T-9', state: 'Done', resolved: true }] } });
    const t2 = a.json.tickets.find((t) => t.id === 'T-2');
    assert.deepEqual(t2.after, ['T-1']);
    assert.deepEqual(a.json.waiting, [{ id: 'T-2', on: [{ id: 'T-1', status: 'starting' }] }]);
    rm(r);
  });

  it('advance names what resumes by itself: a parked ticket the state reports unblocked', () => {
    const r = root();
    const dir = reached(r, 'T-1', 'triage', 'triage');
    // the stop is a parked one; a re-check recorded through the state script resolves its blockers
    append(dir, [['2026-01-01T10:12Z', 'triage', 'started'], ['2026-01-01T10:13Z', 'triage', 'stopped', 'blocked by T-9 — nothing to answer — parked']]);
    planOf(r, { from: 'sprint', lanes: 1, tickets: [T('T-1', { inFlight: true }), T('T-2')] });
    assert.deepEqual(advanceOf(r).json.resumable, []);
    const st = spawnSync(process.execPath, [STATE, 'blockers', dir, JSON.stringify([{ id: 'T-9', state: 'Done', resolved: true }])], { encoding: 'utf8' });
    assert.equal(st.status, 0);
    const a = advanceOf(r);
    assert.deepEqual(a.json.resumable, ['T-1']);
    assert.equal(a.json.inFlight.find((i) => i.id === 'T-1').status, 'stopped');
    rm(r);
  });
});

describe('day.mjs eod — the day\'s close', () => {
  it('counts what finished today from the stage dates, lists what stands where, carries over the unfinished and sums today\'s tokens', () => {
    const r = root();
    writeJson(r, 'tiers.json', { low: 'a', medium: 'b', high: 'c', prices: { low: 1, medium: 4, high: 20 } });
    const w = join(r, 'work');
    // A: accepted today, with an estimate and tokens; B: merged today but not accepted; C: stopped; D: running; E: finished yesterday
    const a = reached(r, 'A-1', 'accept');
    writeJson(a, 'ticket.json', { ...JSON.parse(readFileSync(join(a, 'ticket.json'), 'utf8')), complexity: 'medium', estimate: { source: 'pipeline', focusedHours: 8, days: 1.5, points: 2, basis: { rating: 'medium' } } });
    append(a, [['2026-01-02T09:00Z', 'accept', 'started'], ['2026-01-02T09:30Z', 'accept', 'done', 'all pass tokens=1000000 tier=medium']]);
    const b = reached(r, 'B-2', 'merge');
    append(b, [['2026-01-02T10:00Z', 'merge', 'started'], ['2026-01-02T10:20Z', 'merge', 'done', 'merged']]);
    const c = reached(r, 'C-3', 'triage', 'triage');
    append(c, [['2026-01-02T11:00Z', 'triage', 'started'], ['2026-01-02T11:05Z', 'triage', 'stopped', 'which env? Default: stage']]);
    reached(r, 'D-4', 'implement');
    reached(r, 'E-5', 'accept'); // finished on 2026-01-01
    planOf(r, { date: '2026-01-02', from: 'sprint', lanes: 1, tickets: [T('D-4', { inFlight: true }), T('F-6')] });
    const e = day('eod', w, '2026-01-02', JSON.stringify({ claudeDir: r, now: '2026-01-02T18:00:00Z' })).json;
    assert.deepEqual(e.done.map((d) => [d.id, d.stage, d.partial || false]), [['A-1', 'accept', false], ['B-2', 'merge', true]]);
    assert.deepEqual(e.inProgress.map((x) => [x.id, x.stage]), [['B-2', 'release'], ['D-4', 'create-pr']]);
    assert.deepEqual(e.stopped.map((x) => [x.id, x.kind, x.question]), [['C-3', 'question', 'which env? Default: stage']]);
    assert.deepEqual(e.missingActuals.map((m) => [m.id, m.estimate]), [['A-1', 8]]);
    const pa = e.perTicket.find((x) => x.id === 'A-1');
    assert.deepEqual([pa.rating, pa.estimate.focusedHours, pa.actual, pa.tokens, pa.cost, pa.pipelineMin > 0], ['medium', 8, null, 1000000, 4, true]);
    assert.ok(!e.perTicket.some((x) => x.id === 'E-5'), 'yesterday\'s ticket is not today\'s');
    assert.deepEqual([e.totals.tokens, e.totals.cost], [1000000, 4]);
    assert.deepEqual(e.carryOver, ['F-6']);
    assert.match(e.calibrate.drift, /no actuals recorded yet/);
    assert.ok(existsSync(join(w, '_day', '2026-01-02.eod.json')));
    // the actual hours recorded through the state script change the drift line
    spawnSync(process.execPath, [STATE, 'actual', a, JSON.stringify({ focusedHours: 12, source: 'person', by: 'eod' })]);
    const e2 = day('eod', w, '2026-01-02', JSON.stringify({ claudeDir: r, now: '2026-01-02T18:00:00Z' })).json;
    assert.deepEqual([e2.missingActuals, e2.perTicket.find((x) => x.id === 'A-1').actual], [[], 12]);
    assert.match(e2.calibrate.drift, /medium: 1 sample, actual\/estimate 1.5×/);
    rm(r);
  });
});

describe('day.mjs — the plan as a proposal the person approves or adjusts', () => {
  const tickets = () => [T('T-1'), T('T-2'), T('T-3', { after: ['T-1'] }), T('T-4', { after: ['T-2'] })];

  it('review: nothing starts, the proposal and the approval question are returned, the stop is listed by the inbox', () => {
    const r2 = root();
    const p = planOf(r2, { from: 'sprint', review: true, tickets: tickets() }).json;
    assert.deepEqual([p.approved, p.start, p.proposed], [null, [], ['T-1', 'T-2']]);
    assert.match(p.question, /^approval needed: day plan 2026-09-19 — 4 tickets — now: T-1, T-2 · then: T-3 after T-1 · T-4 after T-2 — approve \(go-ahead\), or adjust: drop <ids> \| only <ids> \| add <ids> \| first <ids> \| lanes=<n\|all>$/);
    assert.match(p.why, /awaiting approval/);
    assert.ok(p.tickets.every((t) => t.status === 'queued' && !t.startedAt), 'nothing marked started');
    const stop = JSON.parse(readFileSync(join(r2, 'work', '_scratch', `plan-day-${DATE}.stop.json`), 'utf8'));
    assert.deepEqual([stop.id, stop.skill, stop.kind, stop.default, stop.resume], [`plan-day:${DATE}`, 'plan-day', 'approval', 'go-ahead', `/tp-plan-day date=${DATE}`]);
    // the question alone cannot be approved: the stop names the plan the person reads first (README § Definitions, Asking the user)
    assert.equal(stop.doc, `_day/${DATE}.md`);
    assert.ok(existsSync(join(r2, 'work', '_day', `${DATE}.md`)), 'and that file is written before the stop is listed');
    const inbox = spawnSync(process.execPath, [STATE, 'inbox', join(r2, 'work')], { encoding: 'utf8' });
    const item = JSON.parse(inbox.stdout).find((i) => i.id === `plan-day:${DATE}`);
    assert.ok(item, 'the inbox lists the proposal');
    assert.deepEqual([item.kind, item.stage, item.default, item.resume], ['approval', 'plan-day', 'go-ahead', `/tp-plan-day date=${DATE}`]);
    // an advance or a status on an unapproved plan starts nothing either
    const a = advanceOf(r2, {});
    assert.deepEqual([a.json.start, a.json.proposed], [[], ['T-1', 'T-2']]);
    assert.match(a.json.why, /awaiting approval/);
    const st = day('status', join(r2, 'work'), DATE).json;
    assert.deepEqual([st.start, st.proposed, st.approved], [[], ['T-1', 'T-2'], null]);
    assert.match(readFileSync(join(r2, 'work', '_day', `${DATE}.md`), 'utf8'), /awaiting approval — a proposal/);
    rm(r2);
  });

  it('approve: the go-ahead marks the plan, removes the stop and starts what is ready; a queued office answer reaches it', () => {
    const r2 = root();
    planOf(r2, { from: 'sprint', review: true, tickets: tickets() });
    // the office queues "go-ahead" for the stop; the skill consumes it on its re-invocation
    const q = spawnSync(process.execPath, [STATE, 'answer', join(r2, 'work'), `plan-day:${DATE}`, 'plan-day', 'go-ahead', '--by', 'office'], { encoding: 'utf8' });
    assert.equal(q.status, 0, q.stderr);
    const taken = spawnSync(process.execPath, [STATE, 'answer', join(r2, 'work'), `plan-day:${DATE}`, '--consume'], { encoding: 'utf8' });
    assert.equal(taken.status, 0, taken.stderr);
    assert.deepEqual([JSON.parse(taken.stdout).answer, JSON.parse(taken.stdout).by], ['go-ahead', 'office']);
    const ok = day('approve', join(r2, 'work'), DATE, JSON.stringify({ by: 'office' }));
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(ok.json.approved && ok.json.approvedBy === 'office');
    assert.deepEqual(ok.json.start, ['T-1', 'T-2'], 'the ready tickets start with the approval');
    assert.ok(!existsSync(join(r2, 'work', '_scratch', `plan-day-${DATE}.stop.json`)), 'the stop is gone');
    assert.deepEqual(ok.json.tickets.filter((t) => t.status === 'starting').map((t) => t.id), ['T-1', 'T-2']);
    assert.match(readFileSync(join(r2, 'work', '_day', `${DATE}.md`), 'utf8'), /approved: .* \(office\)/);
    const later = advanceOf(r2, { dry: true }).json;
    assert.equal(later.proposed, undefined, 'an approved plan advances normally');
    rm(r2);
  });

  it('adjustments: drop takes a ticket and its dependents out, only keeps a ticket with its prerequisites, first reorders', () => {
    const r2 = root();
    const drop = planOf(r2, { from: 'sprint', review: true, drop: ['T-2'], tickets: tickets() }).json;
    assert.deepEqual(drop.tickets.map((t) => t.id), ['T-1', 'T-3']);
    assert.deepEqual(drop.skipped.map((s) => [s.id, s.why]), [['T-2', 'dropped by the person'], ['T-4', 'waits on T-2 (dropped by the person)']]);
    assert.deepEqual(drop.adjustments.drop, ['T-2']);
    assert.match(drop.question, /skipped: T-2, T-4/);
    const only = planOf(r2, { from: 'sprint', review: true, only: ['T-3'], tickets: tickets() }).json;
    assert.deepEqual(only.tickets.map((t) => t.id), ['T-1', 'T-3'], 'T-3 with its prerequisite T-1');
    assert.ok(only.skipped.some((s) => s.id === 'T-2' && /left out by the person/.test(s.why)));
    const first = planOf(r2, { from: 'sprint', review: true, first: ['T-2', 'T-4'], tickets: tickets() }).json;
    assert.deepEqual(first.tickets.map((t) => t.id), ['T-2', 'T-1', 'T-4', 'T-3'], 'the person\'s order first, dependency levels kept');
    assert.deepEqual(first.proposed, ['T-2', 'T-1']);
    rm(r2);
  });

  it('a plan without review is approved as planned — the script\'s own callers keep their behaviour', () => {
    const r2 = root();
    const p = planOf(r2, { from: 'sprint', tickets: tickets() }).json;
    assert.ok(p.approved && p.approvedBy === 'plan');
    assert.deepEqual(p.start, ['T-1', 'T-2']);
    assert.ok(!existsSync(join(r2, 'work', '_scratch', `plan-day-${DATE}.stop.json`)));
    // a plan an older planner wrote carries no `approved` field at all: it ran as drawn, so it advances as approved
    const file = join(r2, 'work', '_day', `${DATE}.json`);
    const { approved, approvedBy, ...older } = JSON.parse(readFileSync(file, 'utf8'));
    writeJson(join(r2, 'work', '_day'), `${DATE}.json`, older);
    const a = advanceOf(r2, { dry: true }).json;
    assert.equal(a.proposed, undefined);
    rm(r2);
  });
});

describe('day.mjs — a person\'s day: hours, focus, switching, carry-over', () => {
  const slices = (p, id) => p.tickets.find((t) => t.id === id).slices;

  it('an 8h day at 65% focus holds 5.2 focused hours: a 6h ticket fills today and spills, a 4h ticket follows tomorrow', () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, tickets: [T('A', { hours: 6 }), T('B', { hours: 4 })] }).json;
    assert.equal(p.day.perDay, 5.2);
    assert.deepEqual(slices(p, 'A'), [{ day: 1, hours: 5.2 }, { day: 2, hours: 0.8 }]);
    assert.deepEqual(slices(p, 'B'), [{ day: 2, hours: 4 }]); // 0.8 + 0.5 switch + 4 = 5.3, within the day's slack
    assert.deepEqual(p.days.map((d) => [d.date, d.load]), [['2026-09-21', 5.2], ['2026-09-22', 5.3]]);
    assert.deepEqual(p.start, ['A', 'B'], "the person's days are a forecast, not a gate: both start now");
    assert.equal(p.later, undefined);
    rm(r);
  });

  it('a lighter meeting day (focus=) changes the fit: at 75% both tickets are whole days', () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, focus: 0.75, tickets: [T('A', { hours: 6 }), T('B', { hours: 4 })] }).json;
    assert.equal(p.day.perDay, 6);
    assert.deepEqual(slices(p, 'A'), [{ day: 1, hours: 6 }]);
    assert.deepEqual(slices(p, 'B'), [{ day: 2, hours: 4 }]);
    const short = planOf(r, { date: '2026-09-22', from: 'sprint', lanes: 3, hours: 4, tickets: [T('C', { hours: 2 })] }).json;
    assert.equal(short.day.perDay, 2.6);
    rm(r);
  });

  it('small tickets share a day, each extra one paying the switch cost; weekends are skipped', () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-25', from: 'sprint', lanes: 5, tickets: [T('A'), T('B'), T('C'), T('D'), T('E')] }).json; // a Friday, 1h each
    assert.deepEqual(p.days.map((d) => [d.date, d.tickets.map((t) => t.id), d.load]), [['2026-09-25', ['A', 'B', 'C', 'D'], 5.5], ['2026-09-28', ['E'], 1]]);
    assert.deepEqual(p.start, ['A', 'B', 'C', 'D', 'E'], 'the Monday forecast for E does not hold it back: all five are independent and start now');
    rm(r);
  });

  it('a dependent never starts before the day its prerequisite ends', () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, tickets: [T('A', { hours: 7 }), T('B', { hours: 1, after: ['A'] }), T('C', { hours: 1 })] }).json;
    assert.deepEqual(p.tickets.map((t) => [t.id, t.day, t.endDay]), [['A', 1, 2], ['C', 2, 2], ['B', 2, 2]]);
    rm(r);
  });

  it('hours come from the tracker when given, else from the model with the rating\'s signals', () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, tickets: [{ id: 'A', hours: 3, hoursSource: 'tracker' }, { id: 'B', rating: 'low' }, { id: 'C', rating: 'high', repos: 2, flags: ['access-control'] }] }).json;
    const by = Object.fromEntries(p.tickets.map((t) => [t.id, t]));
    assert.deepEqual([by.A.hours, by.A.hoursSource], [3, 'tracker']);
    assert.deepEqual([by.B.hours, by.B.hoursSource], [2.5, 'model']); // 2h × 1.35 → 2.7 → half-hour rounding
    assert.equal(by.C.hours, 30); // 16 × (1 + 0.25 + 0.15) × 1.35 = 30.24 → 30
    assert.match(by.C.hoursWhy, /2 repos/);
    rm(r);
  });

  it('a ticket already running takes its attention share out of today', () => {
    const r = root();
    reached(r, 'X', 'implement'); // in flight, no hours given → model estimate (medium, 8h) × attend 0.25 = 2h
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, tickets: [{ id: 'X', rating: 'medium' }, T('A', { hours: 4 })] }).json;
    assert.deepEqual(p.inFlight.map((i) => [i.id, i.hours, i.attention]), [['X', 8, 2]]);
    // 2h of attention, then the 0.5h switch to A, then A until the day is full
    assert.deepEqual(p.days[0], { day: 1, date: '2026-09-21', tickets: [{ id: 'A', hours: 2.7 }], load: 5.2, capacity: 5.2, carried: 'in-flight attention' });
    assert.deepEqual(slices(p, 'A'), [{ day: 1, hours: 2.7 }, { day: 2, hours: 1.3 }]);
    rm(r);
  });

  it("a ticket placed on tomorrow still starts today when it is ready — and a dependent the moment its prerequisite lands", () => {
    const r = root();
    const p = planOf(r, { date: '2026-09-21', from: 'sprint', lanes: 3, tickets: [T('A', { hours: 5 }), T('B', { hours: 4 }), T('C', { hours: 1, after: ['A'] })] }).json;
    assert.deepEqual(p.tickets.find((t) => t.id === 'B').day, 2, 'the forecast puts B on day 2');
    assert.deepEqual(p.start, ['A', 'B'], 'and B starts today regardless');
    const adv = () => day('advance', join(r, 'work'), '2026-09-21', '{}');
    let a = adv();
    assert.deepEqual([a.json.start, a.json.waiting.map((w) => w.id)], [[], ['C']]);
    assert.match(a.json.why, /waiting on prerequisites: C on A/);
    reached(r, 'A', 'accept');
    a = adv();
    assert.deepEqual(a.json.start, ['C']);
    rm(r);
  });
});
