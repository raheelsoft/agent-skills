// Unit tests for the office half of skills/_lib/state.mjs: agent join/leave records and the office JSON.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STATE, tmp, rm, state, writeJson, readJson, progress, append, pickedUp, ARTEFACTS, officeConfig, joinAgent, leaveAgent, stampAgo,
  day,
} from './helpers.mjs';

const agentsDir = (workroot) => join(workroot, '_office', 'agents');
const files = (workroot) => (existsSync(agentsDir(workroot)) ? readdirSync(agentsDir(workroot)) : []);
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('agent join', () => {
  let root, work;
  before(() => { root = tmp(); work = join(root, 'work'); mkdirSync(work); });
  after(() => rm(root));

  it('writes one record per agent with a name from the pool, and returns it', () => {
    const r = joinAgent(work, { id: 'T-1:implement:engineer', level: 'engineer', stage: 'implement', ticket: 'T-1', parent: 'T-1:implement:lead', rating: 'high' });
    assert.equal(r.code, 0);
    const a = r.json;
    assert.equal(a.id, 'T-1:implement:engineer');
    assert.equal(a.level, 'engineer');
    assert.equal(a.role, 'engineer', 'role defaults to the level');
    assert.equal(a.rating, 'high');
    assert.equal(a.left, null);
    assert.match(a.started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(typeof a.name === 'string' && a.name.length > 0);
    assert.equal(files(work).length, 1);
    assert.match(files(work)[0], /^T-1_implement_engineer-[0-9a-f]{6}\.json$/, 'a filesystem-safe name plus a hash of the id');
    assert.deepEqual(readJson(agentsDir(work), files(work)[0]), a);
  });

  it('gives the same id the same name in another office, and a re-join keeps name and start while clearing left', () => {
    const other = tmp(); const w2 = join(other, 'work'); mkdirSync(w2);
    const a = joinAgent(work, { id: 'T-9:plan:lead', level: 'lead', stage: 'plan', ticket: 'T-9' }).json;
    const b = joinAgent(w2, { id: 'T-9:plan:lead', level: 'lead', stage: 'plan', ticket: 'T-9' }).json;
    assert.equal(a.name, b.name);
    rm(other);
    leaveAgent(work, 'T-9:plan:lead', 'stopped');
    const again = joinAgent(work, { id: 'T-9:plan:lead', level: 'lead', stage: 'plan', ticket: 'T-9', role: 'plan lead' }).json;
    assert.equal(again.name, a.name);
    assert.equal(again.started, a.started);
    assert.equal(again.left, null);
    assert.equal(again.role, 'plan lead', 'the new role is taken');
  });

  it("creates a missing work root on join — a fresh install's first agent registers before any ticket exists", () => {
    const fresh = join(root, 'fresh-work');
    const r = joinAgent(fresh, { id: 'first', level: 'lead', stage: 's' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(fresh, '_office', 'agents')));
  });

  it('rejects a bad level, a missing id, a missing stage, bad JSON and a missing work root argument', () => {
    assert.equal(joinAgent(work, { id: 'x', level: 'boss', stage: 's' }).code, 2);
    assert.match(joinAgent(work, { id: 'x', level: 'boss', stage: 's' }).stderr, /level must be one of manager, lead, engineer, qa, reviewer/);
    assert.equal(joinAgent(work, { level: 'lead', stage: 's' }).code, 2);
    assert.equal(joinAgent(work, { id: 'has space', level: 'lead', stage: 's' }).code, 2);
    assert.equal(joinAgent(work, { id: 'x', level: 'lead' }).code, 2);
    assert.equal(state('agent', 'join', work, '{nope').code, 2);
    assert.equal(state('agent', 'join').code, 2);
    assert.equal(state('agent', 'dance', work).code, 2);
  });

  it('survives eight parallel joins', async () => {
    const w = join(root, 'parallel'); mkdirSync(w);
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((res, rej) => {
      const c = spawn(process.execPath, [STATE, 'agent', 'join', w, JSON.stringify({ id: `T-2:verify:qa:${i}`, level: 'qa', stage: 'create-pr', ticket: 'T-2' })]);
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
    })));
    assert.equal(files(w).length, 8);
    const office = state('office', w).json;
    assert.equal(office.agents.length, 8);
    assert.equal(new Set(office.agents.map((a) => a.id)).size, 8);
  });

  it('probes past names live agents of the same level hold, and falls back to "<name> 2"', () => {
    const r2 = tmp(); const w = join(r2, 'work'); mkdirSync(w);
    officeConfig(r2, { names: { leads: ['Only'] } });
    const a = joinAgent(w, { id: 'A:plan:lead', level: 'lead', stage: 'plan' }).json;
    const b = joinAgent(w, { id: 'B:plan:lead', level: 'lead', stage: 'plan' }).json;
    assert.equal(a.name, 'Only');
    assert.equal(b.name, 'Only 2');
    officeConfig(r2, { names: { engineers: ['One', 'Two'] } });
    const c = joinAgent(w, { id: 'C:implement:engineer', level: 'engineer', stage: 'implement' }).json;
    const d = joinAgent(w, { id: 'D:implement:engineer', level: 'engineer', stage: 'implement' }).json;
    assert.notEqual(c.name, d.name, 'two live engineers never share a name while the pool has room');
    leaveAgent(w, 'C:implement:engineer');
    const e = joinAgent(w, { id: 'E:implement:engineer', level: 'engineer', stage: 'implement' }).json;
    assert.ok(['One', 'Two'].includes(e.name), 'a departed agent\'s name is free again');
    rm(r2);
  });
});

describe('agent leave and pruning', () => {
  let root, work;
  before(() => { root = tmp(); work = join(root, 'work'); mkdirSync(work); });
  after(() => rm(root));

  it('marks the record left with a status, maps error to gone, and tolerates an unknown id', () => {
    joinAgent(work, { id: 'T-1:triage:lead', level: 'lead', stage: 'triage', ticket: 'T-1' });
    let r = leaveAgent(work, 'T-1:triage:lead');
    assert.equal(r.code, 0);
    assert.equal(r.json.left.status, 'done');
    r = leaveAgent(work, 'T-1:triage:lead', 'error');
    assert.equal(r.json.left.status, 'gone');
    r = leaveAgent(work, 'nobody', 'stopped');
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { id: 'nobody', left: null, note: 'unknown agent' });
    assert.equal(leaveAgent(join(root, 'nope'), 'x').code, 2);
  });

  it('forgets agents that left over an hour ago or were never refreshed for a day', () => {
    joinAgent(work, { id: 'old:left', level: 'qa', stage: 'accept' });
    joinAgent(work, { id: 'old:stale', level: 'qa', stage: 'accept' });
    const dir = agentsDir(work);
    for (const f of readdirSync(dir)) {
      const a = readJson(dir, f);
      if (a.id === 'old:left') writeJson(dir, f, { ...a, left: { at: iso(2 * 3600000), status: 'done' } });
      if (a.id === 'old:stale') writeJson(dir, f, { ...a, started: iso(25 * 3600000), updated: iso(25 * 3600000) });
    }
    joinAgent(work, { id: 'new:one', level: 'qa', stage: 'accept' }); // any join prunes
    const ids = readdirSync(dir).map((f) => readJson(dir, f).id);
    assert.ok(!ids.includes('old:left') && !ids.includes('old:stale'));
    assert.ok(ids.includes('new:one') && ids.includes('T-1:triage:lead'), 'recent records stay');
  });
});

describe('office', () => {
  let root, work, t1;
  before(() => {
    root = tmp(); work = join(root, 'work');
    t1 = pickedUp(root, { id: 'T-1', repos: [{ name: 'api' }, { name: 'web' }] });
    ARTEFACTS.triage(t1, 'direct');
    append(t1, [['2026-01-01T10:06Z', 'triage', 'done', 'direct'], ['2026-01-01T10:07Z', 'implement:api', 'started']]);
    writeJson(t1, 'lock.json', { owner: 'sess', since: iso(60000), updated: iso(1000) });
    // keep the ticket "recent": the last event must be within the stale window
    append(t1, [[new Date().toISOString().slice(0, 16) + 'Z', 'implement:api', 'note', 'step 1 started']]);
  });
  after(() => rm(root));

  it('uses defaults without office.json and the file when present', () => {
    let o = state('office', work).json;
    assert.ok(o.team.startsWith('pipeline-test-'), 'team defaults to the folder above work/');
    assert.deepEqual([o.poll, o.linger], [2500, 120]);
    assert.match(o.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    officeConfig(root, { team: 'Platform', poll: 1000, linger: 5, projects: ['mobile'], names: { managers: ['Boss'] } });
    o = state('office', work).json;
    assert.deepEqual([o.team, o.poll, o.linger], ['Platform', 1000, 5]);
    assert.ok(o.projects.some((p) => p.name === 'mobile'), 'configured projects are always drawn');
  });

  it('routes agents to projects and lanes, and derives their status from their stage and relatives', () => {
    joinAgent(work, { id: 'T-1:run-ticket:manager', level: 'manager', stage: 'run-ticket', ticket: 'T-1' });
    joinAgent(work, { id: 'T-1:triage:lead', level: 'lead', stage: 'triage', ticket: 'T-1', parent: 'T-1:run-ticket:manager' });
    joinAgent(work, { id: 'T-1:implement:api:lead', level: 'lead', stage: 'implement:api', ticket: 'T-1', parent: 'T-1:run-ticket:manager' });
    joinAgent(work, { id: 'T-1:implement:api:engineer', level: 'engineer', stage: 'implement:api', ticket: 'T-1', parent: 'T-1:implement:api:lead' });
    joinAgent(work, { id: 'T-1:merge:web:reviewer', level: 'reviewer', stage: 'merge:web', ticket: 'T-1', parent: 'T-1:merge:web:lead' });
    joinAgent(work, { id: 'loose:status:lead', level: 'lead', stage: 'status' });
    const o = state('office', work).json;
    const by = Object.fromEntries(o.agents.map((a) => [a.id, a]));
    assert.deepEqual(by['T-1:run-ticket:manager'].projects, [], 'the manager sits in the team lane');
    assert.equal(by['T-1:run-ticket:manager'].status, 'working', 'a live lock keeps the manager working');
    assert.deepEqual(by['T-1:triage:lead'].projects, ['api', 'web'], 'a shared stage of a cross-repo ticket appears in every room');
    assert.equal(by['T-1:triage:lead'].status, 'done');
    assert.deepEqual(by['T-1:implement:api:lead'].projects, ['api'], 'a per-repo stage maps to its repo');
    assert.equal(by['T-1:implement:api:lead'].status, 'working');
    assert.equal(by['T-1:implement:api:engineer'].status, 'working');
    assert.deepEqual(by['T-1:merge:web:reviewer'].projects, ['web']);
    assert.equal(by['T-1:merge:web:reviewer'].status, 'working', 'a pending stage counts as working (registered before started)');
    assert.deepEqual(by['loose:status:lead'].projects, [], 'no ticket → unassigned');
    assert.equal(by['loose:status:lead'].status, 'working');
    assert.deepEqual(o.projects.map((p) => p.name).sort(), ['api', 'mobile', 'web']);
    assert.deepEqual(o.projects.find((p) => p.name === 'api').tickets, ['T-1']);
    assert.equal(o.tickets.length, 1);
    assert.deepEqual(o.tickets[0].repos, ['api', 'web']);
  });

  it('shows a stop with its question, a left status as is, gone below a departed parent, and gone when the ticket went quiet', () => {
    append(t1, [[new Date().toISOString().slice(0, 16) + 'Z', 'implement:api', 'stopped', 'step 2 — which index?']]);
    leaveAgent(work, 'T-1:triage:lead', 'done');
    leaveAgent(work, 'T-1:implement:api:lead', 'stopped');
    let o = state('office', work).json;
    let by = Object.fromEntries(o.agents.map((a) => [a.id, a]));
    assert.equal(by['T-1:implement:api:lead'].status, 'stopped');
    assert.equal(by['T-1:implement:api:engineer'].status, 'gone', 'a child of a departed parent is gone whatever its stage says');
    // a still-registered lead on the stopped stage carries the question
    joinAgent(work, { id: 'T-1:implement:api:lead2', level: 'lead', stage: 'implement:api', ticket: 'T-1', parent: 'T-1:run-ticket:manager' });
    o = state('office', work).json; by = Object.fromEntries(o.agents.map((a) => [a.id, a]));
    assert.equal(by['T-1:implement:api:lead2'].status, 'stopped');
    assert.equal(by['T-1:implement:api:lead2'].question, 'step 2 — which index?');
    assert.equal(by['T-1:run-ticket:manager'].status, 'working', 'the manager stays while the lock is live');
    // the lock goes stale and the ticket goes quiet → everyone still registered is gone
    writeJson(t1, 'lock.json', { owner: 'sess', since: iso(8 * 3600000), updated: iso(7 * 3600000) });
    progress(t1, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up']]);
    o = state('office', work).json; by = Object.fromEntries(o.agents.map((a) => [a.id, a]));
    assert.equal(by['T-1:implement:api:lead2'].status, 'gone');
    assert.equal(by['T-1:run-ticket:manager'].status, 'gone');
  });

  it('keeps a done ticket only while an agent still references it, and never lists _office or _scratch as tickets', () => {
    const t2 = pickedUp(root, { id: 'T-2' });
    ARTEFACTS.triage(t2, 'direct'); ARTEFACTS.implement(t2); ARTEFACTS.pr(t2); ARTEFACTS.release(t2); ARTEFACTS.accept(t2);
    append(t2, [['2026-01-01T10:06Z', 'triage', 'done', 'x'], ['2026-01-01T10:07Z', 'implement', 'done', 'x'], ['2026-01-01T10:08Z', 'create-pr', 'done', 'x'], ['2026-01-01T10:08Z', 'merge', 'done', 'x'], ['2026-01-01T10:09Z', 'release', 'done', 'x'], ['2026-01-01T10:10Z', 'accept', 'done', 'x']]);
    mkdirSync(join(work, '_scratch'), { recursive: true }); writeFileSync(join(work, '_scratch', 'progress.md'), '- 2026-01-01T10:00Z · triage · started\n');
    mkdirSync(join(work, '_office'), { recursive: true }); writeFileSync(join(work, '_office', 'progress.md'), '- 2026-01-01T10:00Z · triage · started\n');
    let o = state('office', work).json;
    assert.ok(!o.tickets.some((t) => t.id === 'T-2'), 'a finished ticket nobody works on is not shown');
    assert.ok(!state('all', work).json.some((r) => r.id === '_scratch' || r.id === '_office'), 'all skips the underscore directories');
    joinAgent(work, { id: 'T-2:retro:lead', level: 'lead', stage: 'retro', ticket: 'T-2' });
    o = state('office', work).json;
    assert.ok(o.tickets.some((t) => t.id === 'T-2'), 'referenced by an agent → shown');
    assert.equal(o.agents.find((a) => a.id === 'T-2:retro:lead').status, 'gone', 'a ticket quiet for hours retires its agents');
    state('log', t2, 'retro', 'started');
    o = state('office', work).json;
    assert.equal(o.agents.find((a) => a.id === 'T-2:retro:lead').status, 'working', 'an extra stage in progress → working');
  });

  it('carries the inbox, the day board, the budget, the doctor and the totals; absent files are null; _inbox is never a ticket', () => {
    let o = state('office', work).json;
    assert.deepEqual([o.day, o.budget, o.doctor], [null, null, null]);
    assert.deepEqual(Object.keys(o.totals).sort(), ['cost', 'partial', 'tickets', 'today', 'tokens', 'unpriced']);
    assert.ok(Array.isArray(o.inbox));
    // a stop → an inbox item with its kind and resume; an answer queued from the office shows on it
    append(t1, [[new Date().toISOString().slice(0, 16) + 'Z', 'implement:api', 'stopped', 'step 2 — which index? btree | hash? Default: btree']]);
    assert.equal(state('answer', work, 'T-1', 'implement:api', 'hash', '--by', 'office').code, 0);
    o = state('office', work).json;
    const item = o.inbox.find((i) => i.id === 'T-1');
    assert.deepEqual([item.kind, item.stage, item.default, item.resume, item.answer.text, item.answer.by], ['question', 'implement:api', 'btree', '/tp-run-ticket T-1 answers="btree"', 'hash', 'office']);
    assert.ok(!o.tickets.some((t) => t.id === '_inbox'), '_inbox is not a ticket');
    assert.ok(!state('all', work).json.some((r) => r.id === '_inbox'));
    const row = o.tickets.find((t) => t.id === 'T-1');
    assert.deepEqual(row.stages.find((s) => s.name === 'implement:api').status, 'stopped');
    assert.ok('cost' in row && 'blockedBy' in row && 'actual' in row);
    // the recorded reading and preflight, with their age
    writeJson(work, '_budget.json', { at: iso(5 * 60000), band: 'economy', binding: { label: '5-hour', percentUsed: 74 }, windows: [], tiers: {}, why: 'x' });
    writeJson(work, '_doctor.json', { at: iso(3600000), ok: true, checks: [{ name: 'node', status: 'ok' }, { name: 'notify', status: 'warn', detail: 'off' }] });
    // the day board: a plan over this root's tickets, read with live statuses and never written
    day('plan', work, JSON.stringify({ date: '2026-01-01', from: 'sprint', lanes: 1, tickets: [{ id: 'T-1', hours: 1 }, { id: 'T-9', hours: 1, after: ['T-1'] }] }));
    const before = readFileSync(join(work, '_day', '2026-01-01.json'), 'utf8');
    o = state('office', work).json;
    assert.deepEqual([o.budget.band, o.budget.ageMin >= 4, o.doctor.ok, o.doctor.counts], ['economy', true, true, { ok: 1, warn: 1, fail: 0 }]);
    assert.deepEqual([o.day.date, o.day.stale, o.day.inFlight.map((i) => [i.id, i.status]), o.day.waiting.map((w) => w.id)], ['2026-01-01', true, [['T-1', 'stopped']], ['T-9']]);
    assert.match(o.day.inFlight[0].question, /which index/);
    assert.equal(readFileSync(join(work, '_day', '2026-01-01.json'), 'utf8'), before, 'the office never writes the plan');
    state('answer', work, 'T-1', '--consume');
  });
});
