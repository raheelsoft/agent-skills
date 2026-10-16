// route.mjs — what /tp:run-ticket does first with a ticket, decided by the script.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmp, rm, pickedUp, append, writeJson, ARTEFACTS, STATE } from './helpers.mjs';
import { routeRun } from '../lib/state/route.mjs';

const bed = (t) => { const root = tmp('route-'); t.after(() => rm(root)); return { root, work: join(root, 'work') }; };
const stoppedAtTriage = (dir, question = 'which env? Default: stage') => append(dir, [['2026-01-01T11:00Z', 'triage', 'started'], ['2026-01-01T11:05Z', 'triage', 'stopped', question]]);

describe('routeRun', () => {
  it('no work directory is a first run; a round above the ticket\'s restarts it', (t) => {
    const { root, work } = bed(t);
    assert.equal(routeRun(work, 'T-1').action, 'first-run');
    pickedUp(root, { id: 'T-1' });
    assert.equal(routeRun(work, 'T-1', { round: 2 }).action, 'restart');
    assert.deepEqual([routeRun(work, 'T-1', { round: 1 }).action, routeRun(work, 'T-1', { round: 1 }).next], ['run', 'triage']);
  });

  it('a done ticket is refused unless forced; a closed one too', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' });
    ARTEFACTS.triage(dir, 'direct');
    append(dir, [['2026-01-01T11:00Z', 'triage', 'started'], ['2026-01-01T11:05Z', 'triage', 'done', 'close'], ['2026-01-01T11:06Z', 'run-ticket', 'done', 'closed early']]);
    writeJson(dir, 'triage.json', { decision: 'close', confidence: 'high', override: null, flags: [], questions: [], why: 'superseded' });
    const r = routeRun(work, 'T-1');
    assert.equal(r.action, 'refuse'); assert.match(r.why, /already closed; round=2 or force=true to re-run/);
    assert.equal(routeRun(work, 'T-1', { force: true }).action, 'rerun');
  });

  it('a stop with no answer is the report; an answer given runs; a queued office answer is consumed', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' }); stoppedAtTriage(dir);
    const s = routeRun(work, 'T-1');
    assert.equal(s.action, 'stop'); assert.equal(s.stop.stage, 'triage');
    assert.deepEqual([routeRun(work, 'T-1', { answers: 'stage' }).action, routeRun(work, 'T-1', { answers: 'stage' }).answers], ['run', 'stage']);
    assert.equal(spawnSync(process.execPath, [STATE, 'answer', work, 'T-1', 'triage', 'prod', '--by', 'office'], { encoding: 'utf8' }).status, 0);
    const q = routeRun(work, 'T-1');
    assert.deepEqual([q.action, q.answers, q.from], ['run', 'prod', 'office']);
    assert.equal(routeRun(work, 'T-1').action, 'stop', 'the answer was consumed');
  });

  it('a queued answer for an old stop is set aside and the stop stays the report', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' }); stoppedAtTriage(dir);
    spawnSync(process.execPath, [STATE, 'answer', work, 'T-1', 'triage', 'old', '--by', 'office'], { encoding: 'utf8' });
    append(dir, [['2026-01-01T12:00Z', 'triage', 'started'], ['2026-01-01T12:05Z', 'triage', 'stopped', 'a newer question? Default: x']]);
    const r = routeRun(work, 'T-1');
    assert.equal(r.action, 'stop'); assert.match(r.note, /set aside/);
  });

  it('a live lock held by another owner is the stop; a usage pause past its reset runs as if answered', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' });
    writeJson(dir, 'lock.json', { owner: 'run-A', since: new Date().toISOString(), updated: new Date().toISOString() });
    const l = routeRun(work, 'T-1', { owner: 'run-B' });
    assert.deepEqual([l.action, l.owner], ['locked', 'run-A']);
    assert.equal(routeRun(work, 'T-1', { owner: 'run-A' }).action, 'run');
  });

  it('a record with problems is an error carrying them', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' });
    append(dir, [['2026-01-01T11:00Z', 'nonsense-stage', 'started']]);
    const r = routeRun(work, 'T-1');
    assert.equal(r.action, 'error'); assert.match(r.needs[0], /unknown stage/);
  });
});

describe('the state script\'s new commands, through the command line', () => {
  const run = (...args) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8' });
  it('route names the ticket by its work directory and prints the action', (t) => {
    const { root } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' });
    const r = run('route', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([JSON.parse(r.stdout).action, JSON.parse(r.stdout).next], ['run', 'triage']);
    assert.equal(JSON.parse(run('route', dir, '--round', '2').stdout).action, 'restart');
    assert.equal(JSON.parse(run('route', join(root, 'work', 'NEW-1')).stdout).action, 'first-run');
  });
  it('approve refuses a ticket that is not waiting; retro-facts and inbox --render print', (t) => {
    const { root, work } = bed(t);
    const dir = pickedUp(root, { id: 'T-1' });
    assert.equal(run('approve', dir).status, 3);
    assert.equal(JSON.parse(run('retro-facts', dir).stdout).id, 'T-1');
    stoppedAtTriage(dir);
    const out = run('inbox', work, '--render', '--date', '2026-10-16');
    assert.match(out.stdout, /^inbox 2026-10-16: 1 open · 0 resume by themselves · 1 questions/);
    assert.match(out.stdout, /1\. T-1 · triage · waiting .* · which env\? Default: stage/);
    assert.match(out.stdout, /act: ask 1$/m);
  });
});
