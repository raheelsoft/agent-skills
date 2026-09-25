// tracker.mjs — the file-backed tracker over the fixture (README § Definitions, Tracker; § Using it, Simulation).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, tmp, rm, readJson } from './helpers.mjs';

const TRACKER = join(CLAUDE_DIR, 'skills', '_lib', 'tracker.mjs');
function tracker(...args) {
  const r = spawnSync(process.execPath, [TRACKER, ...args], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, json, stderr: r.stderr };
}

describe('tracker.mjs', () => {
  let root, file, claude;
  before(() => {
    root = tmp('tracker-'); file = join(root, 'fixture.json');
    copyFileSync(join(CLAUDE_DIR, 'tests', 'fixtures', 'tracker.json'), file);
    claude = join(root, '.claude'); mkdirSync(join(claude, 'skills', '_lib'), { recursive: true });
    writeFileSync(join(claude, 'tracker.json'), JSON.stringify({ kind: 'fixture', path: file }));
  });
  after(() => rm(root));

  it('reads a ticket with its blockers\' states and children, lists with filters, and the iterations, labels, states', () => {
    const t = tracker('get', 'DEMO-3', '--file', file).json;
    assert.deepEqual([t.id, t.link, t.blockedBy], ['DEMO-3', 'fixture://DEMO-3', [{ id: 'DEMO-2', state: 'Todo', title: 'BE: GET /contacts/export returns CSV' }]]);
    assert.deepEqual(tracker('get', 'DEMO-1', '--file', file).json.children.map((c) => c.id), ['DEMO-2', 'DEMO-3']);
    assert.deepEqual(tracker('list', '--file', file, '--iteration', 'Sprint 4', '--open').json.map((x) => x.id), ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
    assert.deepEqual(tracker('list', '--file', file, '--label', 'api', '--state', 'todo').json.map((x) => x.id), ['DEMO-2', 'DEMO-4', 'DEMO-5']);
    assert.deepEqual(tracker('list', '--file', file, '--parent', 'DEMO-1').json.map((x) => x.id), ['DEMO-2', 'DEMO-3']);
    assert.deepEqual(tracker('list', '--file', file, '--assignee', 'dev').json.map((x) => x.id), ['DEMO-8']);
    assert.deepEqual(tracker('iterations', '--file', file).json.map((i) => i.name), ['Sprint 4', 'Sprint 5']);
    assert.ok(tracker('labels', '--file', file).json.some((l) => l.name === 'Sprint 4'));
    assert.deepEqual(tracker('states', '--file', file).json[0], 'Backlog');
    assert.deepEqual(tracker('me', '--file', file).json, { me: 'dev', project: 'Demo CRM', team: 'DEMO' });
    // the fixture is found through <.claude>/tracker.json too
    assert.equal(tracker('get', 'DEMO-4', '--claude', claude).json.title, 'BE: contacts list ignores the `q` filter');
  });

  it('save patches a ticket, keeps history and normalises the state; comment and create append', () => {
    let r = tracker('save', 'DEMO-4', JSON.stringify({ state: 'in progress', assignee: 'me', estimate: 2 }), '--file', file);
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.state, r.json.assignee, r.json.estimate, r.json.history.length], ['In Progress', 'dev', 2, 1]);
    assert.equal(readJson(root, 'fixture.json').tickets.find((t) => t.id === 'DEMO-4').state, 'In Progress', 'persisted');
    r = tracker('comment', 'DEMO-4', 'picked up by the pipeline', '--file', file);
    assert.deepEqual([r.code, r.json.comments, r.json.link], [0, 1, 'fixture://DEMO-4#comment-1']);
    r = tracker('create', JSON.stringify({ title: 'BE: found in review', labels: ['api'], description: 'x' }), '--file', file);
    assert.deepEqual([r.code, r.json.id, r.json.state], [0, 'DEMO-9', 'Backlog']);
    assert.equal(tracker('list', '--file', file).json.length, 9);
  });

  it('refuses an unknown id, a bad patch, an unknown state and a missing fixture', () => {
    assert.equal(tracker('get', 'DEMO-99', '--file', file).code, 2);
    let r = tracker('save', 'DEMO-4', JSON.stringify({ nope: 1 }), '--file', file);
    assert.deepEqual([r.code, /cannot patch nope/.test(r.stderr)], [2, true]);
    r = tracker('save', 'DEMO-4', JSON.stringify({ state: 'Shipped' }), '--file', file);
    assert.match(r.stderr, /unknown state/);
    r = tracker('save', 'DEMO-4', JSON.stringify({ blockedBy: 'DEMO-1' }), '--file', file);
    assert.match(r.stderr, /blockedBy must be an array/);
    r = tracker('list', '--claude', join(root, 'nowhere'));
    assert.match(r.stderr, /tracker\.json missing/);
    assert.equal(tracker('comment', 'DEMO-4', '', '--file', file).code, 2);
  });
});
