// Unit tests for skills/_lib/state.mjs — every subcommand, run as a child process on temp work directories.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  tmp, rm, state, writeJson, readJson, touch, progress, append, ticket, pickedUp,
  gitRepoWithWorktree, ARTEFACTS, stageOf, statuses, stampAgo, SEP,
} from './helpers.mjs';

describe('usage', () => {
  it('rejects a missing or unknown subcommand with exit 2', () => {
    assert.equal(state().code, 2);
    const r = state('bogus', '/nowhere');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /usage: state\.mjs/);
  });
});

describe('log', () => {
  let root, dir;
  before(() => { root = tmp(); dir = join(root, 'T-1'); mkdirSync(dir); });
  after(() => rm(root));

  it('creates progress.md with a heading and appends a well-formed line; started needs no summary', () => {
    const r = state('log', dir, 'start-ticket', 'started');
    assert.equal(r.code, 0);
    const file = readFileSync(join(dir, 'progress.md'), 'utf8');
    assert.ok(file.startsWith('# progress\n\n'));
    const line = file.trim().split('\n').pop();
    assert.equal(r.stdout.trim(), line);
    const f = line.slice(2).split(SEP);
    assert.equal(f.length, 3, 'no trailing empty summary field');
    assert.match(f[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    assert.deepEqual(f.slice(1), ['start-ticket', 'started']);
  });

  it('writes summary and links as separate fields', () => {
    state('log', dir, 'start-ticket', 'done', 'picked up', 'https://tracker/T-1');
    const line = readFileSync(join(dir, 'progress.md'), 'utf8').trim().split('\n').pop();
    assert.deepEqual(line.slice(2).split(SEP).slice(1), ['start-ticket', 'done', 'picked up', 'https://tracker/T-1']);
  });

  it('strips separators and line breaks from the summary so the line stays parseable', () => {
    state('log', dir, 'triage', 'note', 'a · b\nc\r\nd');
    const line = readFileSync(join(dir, 'progress.md'), 'utf8').trim().split('\n').pop();
    const f = line.slice(2).split(SEP);
    assert.equal(f.length, 4);
    assert.equal(f[3], 'a - b c d');
  });

  it('rejects a bad event, a missing summary, a non-directory and an unknown stage (exit 2)', () => {
    assert.equal(state('log', dir, 'triage', 'finished', 'x').code, 2);
    assert.equal(state('log', dir, 'triage', 'done').code, 2);
    assert.equal(state('log', join(root, 'nope'), 'triage', 'started').code, 2);
    const r = state('log', dir, 'bogus', 'started');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown stage "bogus"/);
    assert.equal(state('log', dir, 'a:b:c', 'started').code, 2);
  });

  it('accepts the extra stages run-ticket and retro', () => {
    assert.equal(state('log', dir, 'run-ticket', 'started').code, 0);
    assert.equal(state('log', dir, 'retro', 'done', '2 proposals').code, 0);
  });

  it('enforces the per-repo suffix rule from ticket.json', () => {
    ticket(dir, [{ name: 'r' }]);
    assert.match(state('log', dir, 'implement:r', 'started').stderr, /single-repo ticket, use plain "implement"/);
    assert.equal(state('log', dir, 'implement', 'started').code, 0);
    assert.match(state('log', dir, 'triage:r', 'started').stderr, /takes no repo suffix/);
    ticket(dir, [{ name: 'r' }, { name: 's' }]);
    assert.match(state('log', dir, 'implement', 'started').stderr, /repos are r, s — use implement:<name>/);
    assert.match(state('log', dir, 'implement:t', 'started').stderr, /repos are r, s/);
    assert.equal(state('log', dir, 'implement:s', 'started').code, 0);
  });

  it('refreshes a live run lock on every line', () => {
    const recent = stampAgo(5 * 60000);
    writeJson(dir, 'lock.json', { owner: 'me', since: '2026-01-01T00:00Z', updated: recent });
    state('log', dir, 'triage', 'note', 'still here');
    const lock = readJson(dir, 'lock.json');
    assert.equal(lock.owner, 'me');
    assert.equal(lock.since, '2026-01-01T00:00Z');
    assert.notEqual(lock.updated, recent);
  });

  it('a note never refreshes a stale lock — a dead run stays dead', () => {
    const old = stampAgo(7 * 3600000);
    writeJson(dir, 'lock.json', { owner: 'ghost', since: old, updated: old });
    state('log', dir, 'triage', 'note', 'blockers re-checked');
    assert.deepEqual(readJson(dir, 'lock.json'), { owner: 'ghost', since: old, updated: old });
  });
});

describe('state — parsing and problems', () => {
  let root;
  before(() => { root = tmp(); });
  after(() => rm(root));

  it('reports a non-directory', () => {
    const r = state('state', join(root, 'missing'));
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.stages, []);
    assert.match(r.json.problems[0], /is not a directory/);
  });

  it('reports a missing progress.md', () => {
    const dir = join(root, 'empty'); mkdirSync(dir);
    assert.deepEqual(state('state', dir).json.problems, ['progress.md missing']);
  });

  it('flags malformed lines by number and keeps parsing the rest', () => {
    const dir = join(root, 'bad'); mkdirSync(dir);
    progress(dir, [
      ['2026-01-01T10:00Z', 'start-ticket', 'started'],
      'not a progress line',
      '- 2026-01-01 · triage · started',
      ['2026-01-01T10:01Z', 'start-ticket', 'stopped', 'assigned to bob — take it over?'],
    ]);
    const j = state('state', dir).json;
    assert.equal(j.problems.length, 1, 'plain text is ignored; only the malformed bullet is a problem');
    assert.match(j.problems[0], /progress\.md:5 does not match/);
    assert.equal(j.stopped.stage, 'start-ticket');
  });

  it('does not complain about ticket.json before pickup has finished', () => {
    const dir = join(root, 'pre'); mkdirSync(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:01Z', 'start-ticket', 'stopped', 'which repo(s)?']]);
    const j = state('state', dir).json;
    assert.deepEqual(j.problems, []);
    assert.equal(j.next, 'start-ticket');
    assert.equal(j.stopped.question, 'which repo(s)?');
  });

  it('requires the artefacts of every done stage', () => {
    const dir = join(root, 'art'); mkdirSync(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:01Z', 'start-ticket', 'done', 'x']]);
    let j = state('state', dir).json;
    assert.ok(j.problems.some((p) => p === 'start-ticket is done but ticket.md is missing'));
    assert.ok(j.problems.some((p) => p === 'start-ticket is done but ticket.json is missing'));
    ticket(dir);
    append(dir, [['2026-01-01T10:02Z', 'triage', 'done', 'direct'], ['2026-01-01T10:03Z', 'implement', 'done', 'x'], ['2026-01-01T10:04Z', 'create-pr', 'done', 'x']]);
    j = state('state', dir).json;
    for (const f of ['triage.md', 'triage.json', 'implement.json', 'pr.json', 'report.md']) assert.ok(j.problems.some((p) => p.endsWith(`${f} is missing`)), f);
    ARTEFACTS.triage(dir); ARTEFACTS.implement(dir); ARTEFACTS.pr(dir, null, { merged: null });
    assert.deepEqual(state('state', dir).json.problems, []);
    append(dir, [['2026-01-01T10:05Z', 'merge', 'done', 'x']]);
    assert.ok(state('state', dir).json.problems.some((p) => p === 'merge is done but pr.json has no merged sha'), 'a merge needs its sha');
    ARTEFACTS.pr(dir);
    assert.deepEqual(state('state', dir).json.problems, []);
  });

  it('flags invalid JSON, a bad repos field, duplicate and nameless repos', () => {
    const dir = join(root, 'json'); mkdirSync(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started']]);
    writeFileSync(join(dir, 'ticket.json'), '{oops');
    assert.match(state('state', dir).json.problems[0], /ticket\.json is not valid JSON/);
    writeJson(dir, 'ticket.json', { id: 'T', repos: 'nope' });
    assert.ok(state('state', dir).json.problems.includes('ticket.json: "repos" must be an array'));
    writeJson(dir, 'ticket.json', { id: 'T', repos: [{ name: 'r' }, { name: 'r' }] });
    assert.ok(state('state', dir).json.problems.includes('ticket.json: duplicate repo names'));
    writeJson(dir, 'ticket.json', { id: 'T', repos: [{}] });
    assert.ok(state('state', dir).json.problems.includes('ticket.json: repos[0] has neither name nor path'));
  });

  it('flags stage names that do not match the ticket', () => {
    const dir = pickedUp(root, { id: 'names', repos: [{ name: 'r' }, { name: 's' }] });
    append(dir, [['2026-01-01T10:06Z', 'implement', 'started'], ['2026-01-01T10:07Z', 'bogus', 'started'], ['2026-01-01T10:08Z', 'implement:x', 'started']]);
    const p = state('state', dir).json.problems;
    assert.ok(p.some((x) => /stage "implement" does not match this ticket's repos \(expected implement:r, implement:s\)/.test(x)));
    assert.ok(p.some((x) => /unknown stage "bogus"/.test(x)));
    assert.ok(p.some((x) => /stage "implement:x" does not match/.test(x)));
  });
});

describe('state — stage lifecycle', () => {
  let root, dir;
  before(() => { root = tmp(); dir = pickedUp(root); });
  after(() => rm(root));

  it('walks pending → in-progress → done and moves next; a direct ticket has no plan stages', () => {
    let j = state('state', dir).json;
    assert.equal(j.next, 'triage');
    assert.deepEqual(j.stages.map((s) => s.name), ['start-ticket', 'triage', 'implement', 'create-pr', 'merge', 'release', 'accept']);
    append(dir, [['2026-01-01T10:06Z', 'triage', 'started']]);
    j = state('state', dir).json;
    assert.equal(stageOf(j, 'triage').status, 'in-progress');
    assert.equal(j.next, 'triage');
    ARTEFACTS.triage(dir, 'direct');
    append(dir, [['2026-01-01T10:07Z', 'triage', 'done', 'direct']]);
    j = state('state', dir).json;
    assert.equal(stageOf(j, 'triage').status, 'done');
    assert.equal(j.decision, 'direct');
    assert.equal(j.next, 'implement');
    assert.equal(j.stopped, null);
  });

  it('a stop stays a stop through notes and parses the implementer step; a new start resumes it', () => {
    append(dir, [['2026-01-01T10:08Z', 'implement', 'started'], ['2026-01-01T10:09Z', 'implement', 'stopped', 'step 3 — which index?'], ['2026-01-01T10:10Z', 'implement', 'note', 'waiting']]);
    let j = state('state', dir).json;
    assert.equal(stageOf(j, 'implement').status, 'stopped');
    assert.deepEqual({ stage: j.stopped.stage, question: j.stopped.question, step: j.stopped.step }, { stage: 'implement', question: 'step 3 — which index?', step: 3 });
    assert.equal(j.next, 'implement');
    append(dir, [['2026-01-01T10:11Z', 'implement', 'started']]);
    j = state('state', dir).json;
    assert.equal(stageOf(j, 'implement').status, 'in-progress');
    assert.equal(j.stopped, null);
  });

  it('ends with next null once accept is done; lastEvent is the final line', () => {
    ARTEFACTS.implement(dir); ARTEFACTS.pr(dir); ARTEFACTS.release(dir); ARTEFACTS.accept(dir);
    append(dir, [
      ['2026-01-01T10:12Z', 'implement', 'done', '2/2'], ['2026-01-01T10:13Z', 'create-pr', 'done', 'PR 1'],
      ['2026-01-01T10:13Z', 'merge', 'done', 'merged'],
      ['2026-01-01T10:14Z', 'release', 'done', 'ok'], ['2026-01-01T10:15Z', 'accept', 'done', '1 pass'],
    ]);
    const j = state('state', dir).json;
    assert.equal(j.next, null);
    assert.deepEqual(j.problems, []);
    assert.equal(j.lastEvent.stage, 'accept');
    assert.equal(j.prs[0].merged, 'abc123');
    assert.equal(j.id, 'T-1');
    assert.equal(j.title, 'a ticket');
  });

  it('a paused run (run-ticket stopped) is the ticket\'s stop until the run starts again, and never outranks a stage stop', () => {
    const dir2 = pickedUp(root, { id: 'paused' });
    append(dir2, [['2026-01-01T10:06Z', 'run-ticket', 'started'], ['2026-01-01T10:07Z', 'run-ticket', 'stopped', 'usage at 92% of the 5-hour limit — resume after 16:10']]);
    let j = state('state', dir2).json;
    assert.deepEqual({ stage: j.stopped.stage, q: j.stopped.question }, { stage: 'run-ticket', q: 'usage at 92% of the 5-hour limit — resume after 16:10' });
    assert.equal(j.next, 'triage', 'the pipeline position is unchanged');
    assert.equal(state('all', join(root, 'work')).json.find((r) => r.id === 'paused').status, 'stopped');
    append(dir2, [['2026-01-01T16:11Z', 'run-ticket', 'started']]);
    j = state('state', dir2).json;
    assert.equal(j.stopped, null, 'the new run clears the pause');
    append(dir2, [['2026-01-01T16:12Z', 'triage', 'started'], ['2026-01-01T16:13Z', 'triage', 'stopped', 'which env?'], ['2026-01-01T16:14Z', 'run-ticket', 'stopped', 'usage at 95%']]);
    j = state('state', dir2).json;
    assert.equal(j.stopped.stage, 'triage', 'a stage stop is the real stop');
  });

  it('reports the current complexity rating: the plan\'s, else triage\'s, else the pickup\'s', () => {
    const d = pickedUp(root, { id: 'rated' });
    assert.equal(state('state', d).json.complexity, null);
    ticket(d, undefined, { id: 'rated', complexity: 'low' });
    assert.equal(state('state', d).json.complexity, 'low');
    writeJson(d, 'triage.json', { decision: 'plan', confidence: 'high', override: null, flags: [], questions: [], complexity: 'medium' }); touch(d, 'triage.md');
    assert.equal(state('state', d).json.complexity, 'medium');
    ARTEFACTS.plan(d, { complexity: 'high' });
    assert.equal(state('state', d).json.complexity, 'high');
    assert.equal(state('all', join(root, 'work')).json.find((r) => r.id === 'rated').complexity, 'high');
  });

  it('extra stages (run-ticket, retro) are logged without affecting next or problems', () => {
    append(dir, [['2026-01-01T10:16Z', 'run-ticket', 'done', 'x'], ['2026-01-01T10:17Z', 'retro', 'started']]);
    const j = state('state', dir).json;
    assert.equal(j.next, null);
    assert.deepEqual(j.problems, []);
    assert.ok(!j.stages.some((s) => s.name === 'retro'));
  });

  it('carries the estimate — triage\'s refinement over the pickup\'s — into the state and the rows', () => {
    const d = pickedUp(root, { id: 'T-est', extra: { estimate: { source: 'pipeline', focusedHours: 8, days: 1.5, points: 2, basis: {} } } });
    assert.deepEqual(state('state', d).json.estimate, { source: 'pipeline', focusedHours: 8, days: 1.5, points: 2, basis: {} });
    writeJson(d, 'triage.json', { decision: 'direct', confidence: 'high', override: null, flags: [], questions: [], estimate: { source: 'pipeline', focusedHours: 5, days: 1, points: 1, basis: {} } }); touch(d, 'triage.md');
    append(d, [['2026-01-01T10:06Z', 'triage', 'done', 'direct']]);
    assert.equal(state('state', d).json.estimate.focusedHours, 5);
    assert.equal(state('all', join(root, 'work')).json.find((r) => r.id === 'T-est').estimate.focusedHours, 5);
  });

  it('a triage that decided close closes the ticket: next null, closed carries the why; a new round reopens it', () => {
    const d = pickedUp(root, { id: 'T-close' });
    writeJson(d, 'triage.json', { decision: 'close', confidence: 'high', override: null, flags: [], questions: [], why: 'delivered by PR #9' }); touch(d, 'triage.md');
    append(d, [['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'done', 'close (high) - low']]);
    let j = state('state', d).json;
    assert.deepEqual([j.next, j.stopped, j.closed, j.problems], [null, null, { at: '2026-01-01T10:07Z', why: 'delivered by PR #9' }, []]);
    assert.equal(state('all', join(root, 'work')).json.find((r) => r.id === 'T-close').status, 'closed');
    append(d, [['2026-01-02T09:00Z', 'start-ticket', 'started'], ['2026-01-02T09:01Z', 'start-ticket', 'done', 'round 2']]);
    j = state('state', d).json;
    assert.deepEqual([j.next, j.closed], ['triage', null]);
  });

  it('a run that ended with stages pending (run-ticket done) is closed until a later stage runs', () => {
    const d = pickedUp(root, { id: 'T-early' });
    ARTEFACTS.triage(d);
    append(d, [['2026-01-01T10:06Z', 'triage', 'done', 'direct'], ['2026-01-01T10:08Z', 'run-ticket', 'done', 'closed as superseded by T-9']]);
    let j = state('state', d).json;
    assert.deepEqual([j.next, j.closed], [null, { at: '2026-01-01T10:08Z', why: 'closed as superseded by T-9' }]);
    append(d, [['2026-01-01T11:00Z', 'implement', 'started']]);
    j = state('state', d).json;
    assert.deepEqual([j.next, j.closed], ['implement', null]);
  });
});

describe('state — planned tickets and derived waits', () => {
  let root, dir;
  before(() => {
    root = tmp(); dir = pickedUp(root);
    ARTEFACTS.triage(dir, 'plan');
    append(dir, [['2026-01-01T10:06Z', 'triage', 'done', 'plan']]);
  });
  after(() => rm(root));

  it('adds plan and plan-check when triage decided plan', () => {
    const j = state('state', dir).json;
    assert.deepEqual(j.stages.map((s) => s.name), ['start-ticket', 'triage', 'plan', 'plan-check', 'implement', 'create-pr', 'merge', 'release', 'accept']);
    assert.equal(j.next, 'plan');
  });

  it('a triage that ended needs-input is a stop, whatever the log says — numbered when there are several', () => {
    ARTEFACTS.triage(dir, 'needs-input');
    writeJson(dir, 'triage.json', { decision: 'needs-input', confidence: 'low', override: null, flags: [], questions: ['which repo?', 'which env?'] });
    const j = state('state', dir).json;
    assert.equal(j.next, 'triage');
    assert.deepEqual({ stage: j.stopped.stage, q: j.stopped.question }, { stage: 'triage', q: '1. which repo? | 2. which env?' });
    ARTEFACTS.triage(dir, 'plan');
  });

  it('structured questions render as one line each — never "[object Object]"', () => {
    ARTEFACTS.triage(dir, 'needs-input');
    writeJson(dir, 'triage.json', { decision: 'needs-input', confidence: 'low', override: null, flags: [], questions: [
      { text: 'Scope — re-scope or close?', choices: ['re-scope', 'close'], default: 're-scope' },
      { question: 'Contract', options: [{ label: 'block on PIK-201' }, { label: 'stub' }] },
      '3. UX — keep manual entry?',
      { odd: true },
    ] });
    const q = state('state', dir).json.stopped.question;
    assert.equal(q, '1. Scope — re-scope or close? — re-scope | close? Default: re-scope | 2. Contract — block on PIK-201 | stub? | 3. UX — keep manual entry? | 4. {"odd":true}');
    assert.doesNotMatch(q, /object Object/);
    writeJson(dir, 'triage.json', { decision: 'needs-input', confidence: 'low', override: null, flags: [], questions: { text: 'one question', default: 'yes' } });
    assert.equal(state('state', dir).json.stopped.question, 'one question Default: yes');
    ARTEFACTS.triage(dir, 'plan');
  });

  it('open questions in the plan are a stop on plan', () => {
    ARTEFACTS.plan(dir, { status: 'open-questions', openQuestions: 2 });
    append(dir, [['2026-01-01T10:07Z', 'plan', 'started'], ['2026-01-01T10:08Z', 'plan', 'done', '3 steps']]);
    const j = state('state', dir).json;
    assert.equal(j.stopped.stage, 'plan');
    assert.match(j.stopped.question, /open questions in plan\.md \(2\)/);
    assert.equal(j.next, 'plan');
  });

  it('a checked plan waits for the person — with the open findings named when the check still says revise', () => {
    ARTEFACTS.plan(dir, { flags: ['access-control'], steps: 3 });
    ARTEFACTS.check(dir, { verdict: 'revise', findings: [{ severity: 'blocking', step: 1, text: 'x' }, { severity: 'advisory', step: 2, text: 'y' }] });
    append(dir, [['2026-01-01T10:09Z', 'plan-check', 'started'], ['2026-01-01T10:10Z', 'plan-check', 'done', 'revise']]);
    let j = state('state', dir).json;
    assert.equal(stageOf(j, 'plan').status, 'stopped');
    assert.equal(stageOf(j, 'plan-check').status, 'done');
    assert.match(j.stopped.question, /approval needed: 3 steps, risks: access-control — the check still has 1 blocking finding/);
    assert.equal(j.next, 'plan');
    ARTEFACTS.check(dir, { verdict: 'revise', override: '2026-01-01T10:11Z — proceed as planned', findings: [] });
    j = state('state', dir).json;
    assert.match(j.stopped.question, /^approval needed: 3 steps, risks: access-control — approve \(go-ahead\)/, 'the override lifts the revise; the plan still waits for its approval');
  });

  it('an unflagged plan with a clean check waits for approval too — every plan is the person\'s to approve', () => {
    const d = pickedUp(root, { id: 'T-plain' });
    ARTEFACTS.triage(d, 'plan'); ARTEFACTS.plan(d, { steps: 2 }); ARTEFACTS.check(d);
    append(d, [['2026-01-01T10:06Z', 'triage', 'done', 'plan'], ['2026-01-01T10:08Z', 'plan', 'done', '2 steps'], ['2026-01-01T10:10Z', 'plan-check', 'done', 'ok']]);
    let j = state('state', d).json;
    assert.deepEqual([j.next, j.stopped.stage], ['plan', 'plan']);
    assert.match(j.stopped.question, /approval needed: 2 steps, risks: none — approve \(go-ahead\) or send a change/);
    writeFileSync(join(d, 'answers.md'), 'go-ahead: 2026-01-01T10:12Z — round 1 — none\n');
    j = state('state', d).json;
    assert.deepEqual([j.next, j.stopped], ['implement', null]);
  });

  it('a stop that cannot be answered from its question names the document to read', () => {
    // the bug this exists for: the person was asked to approve a plan in an interview that showed only the
    // one-line question — nothing to read, nothing to send a change against (README § Definitions, Asking the user)
    const d = pickedUp(root, { id: 'T-doc' });
    ARTEFACTS.triage(d, 'plan'); ARTEFACTS.plan(d, { steps: 2 }); ARTEFACTS.check(d);
    append(d, [['2026-01-01T10:06Z', 'triage', 'done', 'plan'], ['2026-01-01T10:08Z', 'plan', 'done', '2 steps'], ['2026-01-01T10:10Z', 'plan-check', 'done', 'ok']]);
    assert.deepEqual([state('state', d).json.stopped.kind, state('state', d).json.stopped.doc], ['approval', 'T-doc/plan.md']);
    assert.equal(state('state', d, '--brief').json.stopped.doc, 'T-doc/plan.md', 'the runner routes on --brief: the document survives it');
    const row = state('inbox', join(root, 'work')).json.find((i) => i.id === 'T-doc');
    assert.equal(row.doc, 'T-doc/plan.md', 'one base for every row: a ticket\'s document and a day plan\'s resolve the same way');

    // open questions in the plan are the same case: the question names a count, the file holds the questions
    ARTEFACTS.plan(d, { status: 'open-questions', openQuestions: 2 });
    assert.equal(state('state', d).json.stopped.doc, 'T-doc/plan.md');

    // a stop whose question carries its own choices needs no document
    const q = pickedUp(root, { id: 'T-ask' });
    writeJson(q, 'triage.json', { decision: 'needs-input', confidence: 'low', flags: [], questions: ['REST or GraphQL? Default: REST'] });
    append(q, [['2026-01-01T10:06Z', 'triage', 'done', 'needs-input']]);
    assert.deepEqual([state('state', q).json.stopped.kind, state('state', q).json.stopped.doc], ['question', null]);
  });

  it('the go-ahead line must start a line and name this round', () => {
    ARTEFACTS.check(dir);
    const ok = () => state('state', dir).json;
    writeFileSync(join(dir, 'answers.md'), '- 2026-01-01 · go-ahead: round 1 — access-control\n');
    assert.equal(ok().stopped.stage, 'plan', 'a bulleted form does not count');
    writeFileSync(join(dir, 'answers.md'), 'go-ahead: 2026-01-01T10:12Z — round 2 — access-control\n');
    assert.equal(ok().stopped.stage, 'plan', 'another round does not count');
    writeFileSync(join(dir, 'answers.md'), 'notes\ngo-ahead: 2026-01-01T10:12Z — round 1 — access-control\n');
    const j = ok();
    assert.equal(j.stopped, null);
    assert.equal(j.next, 'implement');
    assert.deepEqual(j.problems, []);
  });

  it('an unexpected plan.json status is a problem, for planned and direct work alike', () => {
    ARTEFACTS.plan(dir, { status: 'weird' });
    assert.ok(state('state', dir).json.problems.some((p) => p === 'plan.json status is "weird"'));
    const direct = pickedUp(root, { id: 'direct' });
    ARTEFACTS.triage(direct, 'direct'); ARTEFACTS.plan(direct, { status: 'open-questions' });
    append(direct, [['2026-01-01T10:06Z', 'triage', 'done', 'direct']]);
    assert.ok(state('state', direct).json.problems.some((p) => /direct work writes a ready plan/.test(p)));
  });
});

describe('state — cross-repo tickets and staleness', () => {
  let root, dir;
  before(() => {
    root = tmp(); dir = pickedUp(root, { repos: [{ name: 'r' }, { name: 's' }] });
    ARTEFACTS.triage(dir, 'direct');
    append(dir, [['2026-01-01T10:06Z', 'triage', 'done', 'direct']]);
  });
  after(() => rm(root));

  it('keys the per-repo stages by repo name and advances next through them in order', () => {
    let j = state('state', dir).json;
    assert.deepEqual(j.stages.map((s) => s.name), ['start-ticket', 'triage', 'implement:r', 'implement:s', 'create-pr:r', 'create-pr:s', 'merge:r', 'merge:s', 'release:r', 'release:s', 'accept']);
    assert.equal(j.next, 'implement:r');
    ARTEFACTS.implement(dir, 'r');
    append(dir, [['2026-01-01T10:07Z', 'implement:r', 'started'], ['2026-01-01T10:08Z', 'implement:r', 'done', 'x']]);
    assert.equal(state('state', dir).json.next, 'implement:s');
    ARTEFACTS.implement(dir, 's');
    append(dir, [['2026-01-01T10:09Z', 'implement:s', 'started'], ['2026-01-01T10:10Z', 'implement:s', 'done', 'x']]);
    j = state('state', dir).json;
    assert.equal(j.next, 'create-pr:r');
    assert.deepEqual(j.problems, []);
  });

  it('siblings in one slot never make each other stale', () => {
    append(dir, [['2026-01-01T10:11Z', 'implement:r', 'started']]);
    const j = state('state', dir).json;
    assert.equal(stageOf(j, 'implement:r').status, 'in-progress');
    assert.equal(stageOf(j, 'implement:s').status, 'done');
    assert.equal(j.next, 'implement:r');
    append(dir, [['2026-01-01T10:12Z', 'implement:r', 'done', 'redo']]);
  });

  it('a fix round on one repo never supersedes another repo\'s finished merge', () => {
    // r is merged (its worktree gone); s is mid-merge and gets a create-pr update round
    ARTEFACTS.pr(dir, 'r'); ARTEFACTS.pr(dir, 's', { merged: null });
    append(dir, [
      ['2026-01-01T10:13Z', 'create-pr:r', 'done', 'PR'], ['2026-01-01T10:14Z', 'create-pr:s', 'done', 'PR'],
      ['2026-01-01T10:15Z', 'merge:r', 'done', 'merged'], ['2026-01-01T10:16Z', 'merge:s', 'started'],
      ['2026-01-01T10:17Z', 'create-pr:s', 'started'], ['2026-01-01T10:18Z', 'create-pr:s', 'done', 'PR round 2'],
    ]);
    const j = state('state', dir).json;
    assert.equal(stageOf(j, 'merge:r').status, 'done', 'repo r is untouched by repo s\'s round');
    assert.equal(stageOf(j, 'merge:s').status, 'in-progress');
    assert.equal(j.next, 'merge:s');
    assert.deepEqual(j.problems, [], 'no worktree check for the merged repo');
    // a shared stage after the per-repo ones is still staled by any repo's re-run
    ARTEFACTS.release(dir, 'r'); ARTEFACTS.release(dir, 's'); ARTEFACTS.accept(dir); ARTEFACTS.pr(dir, 's');
    append(dir, [
      ['2026-01-01T10:19Z', 'merge:s', 'done', 'merged'], ['2026-01-01T10:20Z', 'release:r', 'done', 'x'], ['2026-01-01T10:21Z', 'release:s', 'done', 'x'],
      ['2026-01-01T10:22Z', 'accept', 'done', 'x'], ['2026-01-01T10:23Z', 'release:s', 'started'],
    ]);
    const k = state('state', dir).json;
    assert.equal(stageOf(k, 'accept').status, 'stale');
    assert.equal(stageOf(k, 'release:r').status, 'done');
    assert.equal(k.next, 'release:s');
  });

  it('an earlier stage running again makes every later done or stopped stage stale, including an old round\'s failed acceptance', () => {
    ARTEFACTS.pr(dir, 'r'); ARTEFACTS.pr(dir, 's'); ARTEFACTS.release(dir, 'r'); ARTEFACTS.release(dir, 's');
    append(dir, [
      ['2026-01-01T10:13Z', 'create-pr:r', 'done', 'x'], ['2026-01-01T10:14Z', 'create-pr:s', 'done', 'x'],
      ['2026-01-01T10:14Z', 'merge:r', 'done', 'x'], ['2026-01-01T10:14Z', 'merge:s', 'done', 'x'],
      ['2026-01-01T10:15Z', 'release:r', 'done', 'x'], ['2026-01-01T10:16Z', 'release:s', 'done', 'x'],
      ['2026-01-01T10:17Z', 'accept', 'started'], ['2026-01-01T10:18Z', 'accept', 'stopped', '1 criteria failed: 1'],
    ]);
    let j = state('state', dir).json;
    assert.equal(j.stopped.stage, 'accept');
    append(dir, [['2026-01-01T11:00Z', 'start-ticket', 'started']]);
    j = state('state', dir).json;
    assert.equal(j.stopped, null, 'the old stop no longer blocks the new round');
    assert.equal(j.next, 'start-ticket');
    const st = statuses(j);
    assert.equal(st['start-ticket'], 'in-progress');
    for (const n of ['triage', 'implement:r', 'implement:s', 'create-pr:r', 'merge:s', 'release:s', 'accept']) assert.equal(st[n], 'stale', n);
  });
});

describe('state — worktrees, prs, lock, retro', () => {
  let root, dir, wt;
  before(() => {
    root = tmp();
    wt = gitRepoWithWorktree(root, 'r', 'feat/t');
    dir = pickedUp(root, { repos: [{ name: 'r', worktree: wt.worktree, branch: 'feat/t' }] });
  });
  after(() => rm(root));

  it('accepts a worktree on the right branch and flags the wrong branch or a missing checkout', () => {
    assert.deepEqual(state('state', dir).json.problems, []);
    wt.git(['checkout', '-q', '-b', 'other'], wt.worktree);
    assert.match(state('state', dir).json.problems[0], /worktree for r is on "other", ticket\.json says "feat\/t"/);
    wt.git(['checkout', '-q', 'feat/t'], wt.worktree);
    const missing = pickedUp(root, { id: 'missing', repos: [{ name: 'r', worktree: join(root, 'gone'), branch: 'feat/t' }] });
    assert.match(state('state', missing).json.problems[0], /worktree for r missing/);
    const plain = join(root, 'plain'); mkdirSync(plain);
    const notGit = pickedUp(root, { id: 'notgit', repos: [{ name: 'r', worktree: plain, branch: 'feat/t' }] });
    assert.match(state('state', notGit).json.problems[0], /is not a git checkout/);
  });

  it('stops checking a repo\'s worktree once its PR is merged — accept detaches it at the merge commit — and lists what is still under wt/', () => {
    ARTEFACTS.triage(dir, 'direct'); ARTEFACTS.implement(dir); ARTEFACTS.pr(dir);
    append(dir, [['2026-01-01T10:06Z', 'triage', 'done', 'x'], ['2026-01-01T10:07Z', 'implement', 'done', 'x'], ['2026-01-01T10:08Z', 'create-pr', 'done', 'x']]);
    wt.git(['checkout', '-q', 'other'], wt.worktree);
    assert.match(state('state', dir).json.problems[0], /worktree for r is on "other"/, 'still checked while the PR is open');
    append(dir, [['2026-01-01T10:09Z', 'merge', 'done', 'x']]);
    const j = state('state', dir).json;
    assert.deepEqual(j.problems, []);
    // the same worktree stays through release and accept (README § Worktrees): detached at the merge commit is fine
    wt.git(['checkout', '-q', '--detach', 'main'], wt.worktree);
    assert.deepEqual(state('state', dir).json.problems, [], 'a detached worktree after the merge is not a problem');
    // wt/ lists directories only — a worktree kept by a finished ticket is what /tp-status and the doctor point at
    mkdirSync(join(dir, 'wt', 'r'), { recursive: true });
    touch(join(dir, 'wt'), 'stray-file');
    assert.deepEqual(state('state', dir).json.worktrees, ['r']);
    wt.git(['checkout', '-q', 'feat/t'], wt.worktree);
  });

  it('--brief keeps only the decision fields a spawner routes on', () => {
    const full = state('state', dir).json;
    const brief = state('state', dir, '--brief').json;
    assert.deepEqual(Object.keys(brief), ['id', 'complexity', 'next', 'stopped', 'closed', 'unblocked', 'lock', 'worktrees', 'problems']);
    for (const k of Object.keys(brief)) assert.deepEqual(brief[k], full[k], k);
    assert.ok(!('stages' in brief) && !('prs' in brief) && !('lastEvent' in brief));
    assert.ok(JSON.stringify(brief).length < JSON.stringify(full).length / 3, 'a fraction of the full state');
  });

  it('reads pr files and flags a malformed one', () => {
    assert.equal(state('state', dir).json.prs[0].url, 'https://host/pr/1');
    writeFileSync(join(dir, 'pr.json'), '{');
    assert.ok(state('state', dir).json.problems.some((p) => /pr\.json is not valid JSON/.test(p)));
    ARTEFACTS.pr(dir);
  });

  it('reports the lock with its staleness', () => {
    assert.equal(state('state', dir).json.lock, null);
    writeJson(dir, 'lock.json', { owner: 'alpha', since: stampAgo(60000), updated: stampAgo(60000) });
    let l = state('state', dir).json.lock;
    assert.deepEqual({ owner: l.owner, stale: l.stale }, { owner: 'alpha', stale: false });
    writeJson(dir, 'lock.json', { owner: 'ghost', since: stampAgo(7 * 3600000), updated: stampAgo(7 * 3600000) });
    assert.equal(state('state', dir).json.lock.stale, true);
    writeJson(dir, 'lock.json', { nope: 1 });
    assert.equal(state('state', dir).json.lock, null, 'a lock without an owner is no lock');
  });

  it('summarises retro.json by target and flags a malformed one', () => {
    assert.equal(state('state', dir).json.retro, null);
    writeJson(dir, 'retro.json', { deviations: 1, proposals: [{ target: 'conventions', text: 'a' }, { target: 'conventions', text: 'b' }, { target: 'skill', text: 'c' }, { text: 'no target' }] });
    assert.deepEqual(state('state', dir).json.retro, { proposals: 4, byTarget: { conventions: 2, skill: 1, unknown: 1 } });
    writeFileSync(join(dir, 'retro.json'), '{bad');
    const j = state('state', dir).json;
    assert.deepEqual(j.retro, { proposals: 0, byTarget: {} });
    assert.ok(j.problems.some((p) => /retro\.json is not valid JSON/.test(p)));
  });
});

describe('check', () => {
  let root;
  before(() => { root = tmp(); });
  after(() => rm(root));

  it('exits 1 with the state when problems exist and 0 otherwise', () => {
    const dir = pickedUp(root);
    assert.equal(state('check', dir).code, 0);
    writeFileSync(join(dir, 'ticket.json'), '{');
    const r = state('check', dir);
    assert.equal(r.code, 1);
    assert.ok(r.json.problems.length > 0, 'the JSON is still printed');
  });
});

describe('durations', () => {
  let root, dir;
  before(() => { root = tmp(); dir = join(root, 'T-1'); mkdirSync(dir); });
  after(() => rm(root));

  it('measures started → done/stopped per stage, keeps the first of repeated starts, and sums resumed runs', () => {
    progress(dir, [
      ['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'],
      ['2026-01-01T10:05Z', 'triage', 'started'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:15Z', 'triage', 'done', 'x'],
      ['2026-01-01T10:20Z', 'implement', 'started'], ['2026-01-01T10:30Z', 'implement', 'stopped', 'step 1 — ?'],
      ['2026-01-01T11:00Z', 'implement', 'started'], ['2026-01-01T11:07Z', 'implement', 'done', 'x'],
      ['2026-01-01T11:07Z', 'create-pr', 'started'],
      ['2026-01-01T11:08Z', 'run-ticket', 'note', 'no start'],
    ]);
    assert.deepEqual(state('durations', dir).json, { 'start-ticket': 5, triage: 10, implement: 17 });
  });

  it('is empty for a missing directory', () => {
    assert.deepEqual(state('durations', join(root, 'nope')).json, {});
  });
});

describe('usage', () => {
  let root, dir;
  before(() => { root = tmp(); dir = join(root, 'T-1'); mkdirSync(dir); });
  after(() => rm(root));

  it('sums tokens=<n> per stage from summaries and links, and reports them in all', () => {
    progress(dir, [
      ['2026-01-01T10:00Z', 'start-ticket', 'started'],
      ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up tokens=1200'],
      ['2026-01-01T10:06Z', 'triage', 'note', 'model: triage → standard', 'tokens=800'],
      ['2026-01-01T10:07Z', 'triage', 'done', 'direct tokens=2500 (agent)'],
      ['2026-01-01T10:08Z', 'implement', 'note', 'no count here'],
      ['2026-01-01T10:09Z', 'implement', 'note', 'tokens=abc'],
    ]);
    assert.deepEqual(state('usage', dir).json, { perStage: { 'start-ticket': 1200, triage: 3300 }, perTier: { untiered: 4500 }, total: 4500, cost: null, unpriced: 4500, partial: false });
    assert.deepEqual(state('usage', join(root, 'nope')).json, { perStage: {}, perTier: {}, total: 0, cost: null, unpriced: 0, partial: false });
    ticket(dir);
    const row = state('all', root).json.find((r) => r.id === 'T-1');
    assert.equal(row.tokens, 4500);
    assert.equal(row.cost, null);
  });

  it('reads the tier on a token note and prices it from tiers.json; untiered tokens stay unpriced; --date keeps one day', () => {
    const r2 = tmp(); const w = join(r2, 'work'); const d = join(w, 'T-2'); mkdirSync(d, { recursive: true });
    writeJson(r2, 'tiers.json', { low: 'a', medium: 'b', high: 'c', prices: { low: 1, medium: 4, high: 20 } });
    progress(d, [
      ['2026-01-01T10:00Z', 'start-ticket', 'started'],
      ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up tokens=1000000 tier=low'],
      ['2026-01-02T10:07Z', 'triage', 'note', 'lead tokens=500000 tier=high'],
      ['2026-01-02T10:08Z', 'triage', 'note', 'old style tokens=250000'],
      ['2026-01-02T10:09Z', 'run-ticket', 'note', 'tokens partial — stage leads unrecorded'],
    ]);
    const u = state('usage', d).json; // claudeDir defaults to the parent of the work root
    assert.deepEqual(u, { perStage: { 'start-ticket': 1000000, triage: 750000 }, perTier: { low: 1000000, high: 500000, untiered: 250000 }, total: 1750000, cost: 11, unpriced: 250000, partial: true });
    assert.deepEqual(state('usage', d, '--date', '2026-01-02').json.perTier, { high: 500000, untiered: 250000 });
    assert.equal(state('usage', d, '--claude', join(r2, 'elsewhere')).json.cost, null, 'no tiers.json there: unpriced');
    ticket(d, undefined, { id: 'T-2' });
    const row = state('all', w).json.find((x) => x.id === 'T-2');
    assert.deepEqual([row.tokens, row.cost, row.tokensUnpriced, row.tokensPartial], [1750000, 11, 250000, true]);
    const t = state('totals', w).json;
    assert.deepEqual([t.tokens, t.cost, t.unpriced, t.partial, t.tickets], [1750000, 11, 250000, true, { active: 1, stopped: 0, done: 0, closed: 0 }]);
    assert.deepEqual(state('totals', w, '--date', '2026-01-01').json, { tokens: 1000000, cost: 1, unpriced: 0, partial: false });
    rm(r2);
  });
});

describe('all', () => {
  let root, workroot;
  before(() => {
    root = tmp(); workroot = join(root, 'work'); mkdirSync(workroot);
    touch(workroot, 'README.md');
    mkdirSync(join(workroot, 'no-progress'));
    mkdirSync(join(workroot, '_review'));
  });
  after(() => rm(root));

  it('returns [] for a missing root and skips entries without progress.md', () => {
    assert.deepEqual(state('all', join(root, 'nope')).json, []);
    assert.deepEqual(state('all', workroot).json, []);
  });

  it('gives one row per ticket with the derived status, lock summary, retro and durations', () => {
    const a = pickedUp(root, { id: 'A' });
    ARTEFACTS.triage(a, 'direct'); ARTEFACTS.implement(a); ARTEFACTS.pr(a); ARTEFACTS.release(a); ARTEFACTS.accept(a);
    append(a, [['2026-01-01T10:06Z', 'triage', 'done', 'x'], ['2026-01-01T10:07Z', 'implement', 'done', 'x'], ['2026-01-01T10:08Z', 'create-pr', 'done', 'x'], ['2026-01-01T10:08Z', 'merge', 'done', 'x'], ['2026-01-01T10:09Z', 'release', 'done', 'x'], ['2026-01-01T10:10Z', 'accept', 'done', 'x']]);
    writeJson(a, 'retro.json', { proposals: [{ target: 'skill' }] });
    const b = pickedUp(root, { id: 'B' });
    append(b, [['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', 'which env?']]);
    writeJson(b, 'lock.json', { owner: 'beta', since: '2026-01-01T10:00Z', updated: stampAgo(1000) });
    const c = pickedUp(root, { id: 'C' });
    const rows = Object.fromEntries(state('all', workroot).json.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(rows).sort(), ['A', 'B', 'C'], 'ids come from ticket.json');
    const { A, B, C } = rows;
    assert.equal(A.status, 'done');
    assert.equal(A.next, null);
    assert.deepEqual(A.retro, { proposals: 1, byTarget: { skill: 1 } });
    assert.equal(A.durations['start-ticket'], 5);
    assert.equal(A.title, 'a ticket');
    assert.deepEqual(A.prs[0], { url: 'https://host/pr/1', verdict: 'PASS', reviewRounds: 1, merged: 'abc123' });
    assert.equal(B.status, 'stopped');
    assert.equal(B.stopped.question, 'which env?');
    assert.deepEqual(B.lock, { owner: 'beta', since: '2026-01-01T10:00Z', stale: false });
    assert.equal(typeof B.ageMin, 'number');
    assert.equal(C.status, 'in-progress');
    assert.equal(C.next, 'triage');
    assert.equal(C.lock, null);
    assert.equal(C.retro, null);
    assert.deepEqual(C.prs, []);
  });

  it('turns a directory that crashes the state computation into an error row instead of failing the listing', () => {
    mkdirSync(join(workroot, 'broken', 'progress.md'), { recursive: true }); // progress.md is a directory
    const rows = state('all', workroot).json;
    const broken = rows.find((r) => r.id === 'broken');
    assert.equal(broken.status, 'error');
    assert.equal(broken.problems.length, 1);
    assert.equal(rows.length, 4, 'the other rows are still there');
  });
});

describe('lock / unlock', () => {
  let root, dir;
  before(() => { root = tmp(); dir = join(root, 'T-1'); mkdirSync(dir); });
  after(() => rm(root));

  it('takes the lock, refuses another owner with exit 3, and is idempotent for the same owner', () => {
    let r = state('lock', dir, 'alpha');
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'locked by alpha');
    const first = readJson(dir, 'lock.json');
    assert.deepEqual(Object.keys(first).sort(), ['owner', 'since', 'updated']);
    r = state('lock', dir, 'beta');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /locked by alpha since .* \(last activity /);
    assert.deepEqual(readJson(dir, 'lock.json'), first, 'a refused lock changes nothing');
    writeJson(dir, 'lock.json', { ...first, updated: '2026-01-01T00:00Z' });
    r = state('lock', dir, 'alpha');
    assert.equal(r.code, 0);
    const again = readJson(dir, 'lock.json');
    assert.equal(again.since, first.since, 'since is kept');
    assert.notEqual(again.updated, '2026-01-01T00:00Z', 'updated is refreshed');
  });

  it('refuses to release another owner\'s live lock unless forced', () => {
    let r = state('unlock', dir, 'beta');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /locked by alpha; pass --force/);
    assert.ok(existsSync(join(dir, 'lock.json')));
    r = state('unlock', dir, 'beta', '--force');
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'unlocked (alpha)');
    assert.ok(!existsSync(join(dir, 'lock.json')));
  });

  it('says so when there is nothing to release, and releases its own lock', () => {
    let r = state('unlock', dir, 'alpha');
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'no lock to release');
    state('lock', dir, 'alpha');
    r = state('unlock', dir, 'alpha');
    assert.equal(r.stdout.trim(), 'unlocked (alpha)');
    assert.ok(!existsSync(join(dir, 'lock.json')));
  });

  it('lets anyone take over or release a stale lock', () => {
    writeJson(dir, 'lock.json', { owner: 'ghost', since: stampAgo(7 * 3600000), updated: stampAgo(7 * 3600000) });
    let r = state('lock', dir, 'beta');
    assert.equal(r.code, 0);
    const l = readJson(dir, 'lock.json');
    assert.equal(l.owner, 'beta');
    assert.notEqual(l.since, stampAgo(7 * 3600000));
    writeJson(dir, 'lock.json', { owner: 'ghost', since: stampAgo(7 * 3600000), updated: stampAgo(7 * 3600000) });
    r = state('unlock', dir, 'beta');
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(dir, 'lock.json')));
  });

  it('needs a directory and an owner (exit 2)', () => {
    assert.equal(state('lock', join(root, 'nope'), 'x').code, 2);
    assert.equal(state('lock', dir).code, 2);
  });
});

describe('stop kinds — every stop names what it is and what continues it', () => {
  let root, dir;
  before(() => { root = tmp(); dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true }); });
  after(() => rm(root));
  const stopWith = (question, extra = []) => {
    ticket(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up'], ...extra, ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', question]]);
    return state('state', dir).json.stopped;
  };

  it('a question carries its default and a resume with answers=', () => {
    const s = stopWith('which repo? api | web? Default: api');
    assert.deepEqual([s.kind, s.default, s.resumable, s.resume], ['question', 'api', false, '/tp-run-ticket T-1 answers="api"']);
    const m = stopWith('1. which repo? api | web? Default: api | 2. keep the flag? | 3. env? Default: stage');
    assert.deepEqual([m.kind, m.default], ['question', '1: api | 2:  | 3: stage']);
    assert.equal(stopWith('hand-off budget spent — step 4').default, 'continue');
    assert.equal(stopWith('step 3 — which index?').step, 3);
  });

  it('an error stop names what a person must do and the resume line it carries', () => {
    const s = stopWith('error: git fetch failed — load the deploy key with ssh-add — resume: /tp-run-ticket T-1 answers=retry');
    assert.deepEqual([s.kind, s.needs, s.resume, s.default], ['error', 'load the deploy key with ssh-add', '/tp-run-ticket T-1 answers=retry', 'retry']);
    assert.equal(stopWith('error: something broke').resume, '/tp-run-ticket T-1 answers=retry');
  });

  it('a usage pause knows its reset time and becomes resumable once it passed', () => {
    const past = stopWith('usage at 92% of the 5-hour window — resume after 2026-01-01T12:00Z');
    assert.deepEqual([past.kind, past.resetAt, past.resumable, past.resume], ['usage', '2026-01-01T12:00:00Z', true, '/tp-run-ticket T-1']);
    const clock = stopWith('usage at 92% of the 5-hour window — resume after 23:30');
    assert.equal(clock.resetAt, '2026-01-01T23:30:00Z');
    assert.equal(stopWith('usage at 92% — resume after 09:00').resetAt, '2026-01-02T09:00:00Z', 'a reset before the stop time is tomorrow');
    const future = stopWith(`usage at 95% — resume after ${new Date(Date.now() + 3600000).toISOString()}`);
    assert.equal(future.resumable, false);
  });

  it('a blocked ticket is a nothing-to-answer stop whose blockers come from ticket.json or from the stop text', () => {
    const legacy = stopWith('blocked by T-8, T-9 — nothing to answer — parked until both land');
    assert.deepEqual([legacy.kind, legacy.resumable, legacy.resume, legacy.needs], ['blocked', false, '/tp-run-ticket T-1', 'parked until both land']);
    assert.deepEqual(state('state', dir).json.blockedBy.map((b) => b.id), ['T-8', 'T-9']);
    // triage decided `blocked`: derived like needs-input, from ticket.json.blockedBy
    ticket(dir, undefined, { blockedBy: [{ id: 'T-8', state: 'Done', resolved: true, soft: false, checkedAt: '2026-01-02T00:00Z' }, { id: 'T-9', state: 'In Review', resolved: false, soft: true, checkedAt: '2026-01-02T00:00Z' }] });
    writeJson(dir, 'triage.json', { decision: 'blocked', confidence: 'high', override: null, flags: [], questions: [], blockedBy: ['T-8', 'T-9'], why: 'needs the export' }); touch(dir, 'triage.md');
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'picked up'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'done', 'blocked (high)']]);
    const j = state('state', dir).json;
    assert.equal(j.next, 'triage');
    assert.deepEqual([j.stopped.stage, j.stopped.kind, j.stopped.question, j.stopped.resumable, j.unblocked], ['triage', 'blocked', 'blocked by T-8, T-9 — nothing to answer — resumes when they are resolved', true, true]);
    assert.equal(state('all', join(root, 'work')).json[0].status, 'stopped');
  });

  it('the plan approval is an approval with go-ahead as its answer', () => {
    ticket(dir);
    ARTEFACTS.triage(dir, 'plan'); ARTEFACTS.plan(dir, { steps: 2, flags: [] }); ARTEFACTS.check(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'done', 'plan'], ['2026-01-01T10:08Z', 'plan', 'started'], ['2026-01-01T10:09Z', 'plan', 'done', '2 steps'], ['2026-01-01T10:10Z', 'plan-check', 'started'], ['2026-01-01T10:11Z', 'plan-check', 'done', 'ok']]);
    const s = state('state', dir).json.stopped;
    assert.deepEqual([s.kind, s.default, s.resume], ['approval', 'go-ahead', '/tp-run-ticket T-1 answers=go-ahead']);
  });
});

describe('answers queued for a stop (_inbox)', () => {
  let root, work, dir;
  before(() => {
    root = tmp(); work = join(root, 'work'); dir = join(work, 'T-1'); mkdirSync(dir, { recursive: true });
    ticket(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', 'which repo? api | web? Default: api']]);
  });
  after(() => rm(root));

  it('queues an answer for the current stop, refuses a stage the ticket is not stopped at, and shows it on the row', () => {
    assert.equal(state('answer', work, 'T-1', 'implement', 'web').code, 3);
    assert.match(state('answer', work, 'T-1', 'implement', 'web').stderr, /stopped at triage, not implement/);
    const r = state('answer', work, 'T-1', 'triage', 'web', '--by', 'office');
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.id, r.json.stage, r.json.at, r.json.answer, r.json.by, r.json.question], ['T-1', 'triage', '2026-01-01T10:07Z', 'web', 'office', 'which repo? api | web? Default: api']);
    const row = state('all', work).json[0];
    assert.deepEqual([row.answer.text, row.answer.by], ['web', 'office']);
    const peek = state('answer', work, 'T-1', '--peek');
    assert.deepEqual([peek.code, peek.json.stale], [0, false]);
    assert.equal(state('answer', work, 'T-2', 'triage', 'x').code, 3, 'unknown ticket: nothing to answer');
  });

  it('consume returns and removes a matching answer, exits 1 with none, and sets a stale one aside', () => {
    let c = state('answer', work, 'T-1', '--consume');
    assert.deepEqual([c.code, c.json.answer], [0, 'web']);
    assert.equal(state('answer', work, 'T-1', '--consume').code, 1);
    assert.equal(state('all', work).json[0].answer, null);
    // queued, then the stop moved on: the answer is stale
    state('answer', work, 'T-1', 'triage', 'api');
    append(dir, [['2026-01-01T10:08Z', 'triage', 'started'], ['2026-01-01T10:09Z', 'triage', 'stopped', 'and the env? Default: stage']]);
    assert.equal(state('all', work).json[0].answer, null, 'an answer for an earlier stop is not shown as pending');
    c = state('answer', work, 'T-1', '--consume');
    assert.deepEqual([c.code, c.json.stale, c.json.current], [3, true, { stage: 'triage', at: '2026-01-01T10:09Z' }]);
    assert.ok(readdirSync(join(work, '_inbox')).some((f) => f.endsWith('.stale.json')));
    assert.equal(state('answer', work, 'T-1', '--consume').code, 1);
  });

  it('a skill without a work directory stops through _scratch/<skill>-<slug>.stop.json and can be answered too', () => {
    mkdirSync(join(work, '_scratch'), { recursive: true });
    writeJson(join(work, '_scratch'), 'plan-day-2026-01-01.stop.json', { id: 'plan-day:2026-01-01', skill: 'plan-day', slug: '2026-01-01', kind: 'question', question: 'which tracker project? Default: PIK', at: '2026-01-01T09:00Z', resume: '/tp-plan-day date=2026-01-01 answers="…"' });
    const items = state('inbox', work).json;
    const sc = items.find((i) => i.id === 'plan-day:2026-01-01');
    assert.deepEqual([sc.ticket, sc.stage, sc.kind, sc.default, sc.resume], [null, 'plan-day', 'question', 'PIK', '/tp-plan-day date=2026-01-01 answers="…"']);
    assert.equal(state('answer', work, 'plan-day:2026-01-01', 'plan-day', 'PIK').code, 0);
    assert.equal(state('inbox', work).json.find((i) => i.id === 'plan-day:2026-01-01').answer.text, 'PIK');
    assert.equal(state('answer', work, 'plan-day:2026-01-01', '--consume').code, 0);
  });
});

describe('blockers and actual hours are recorded through the script', () => {
  let root, work, dir;
  before(() => {
    root = tmp(); work = join(root, 'work'); dir = join(work, 'T-1'); mkdirSync(dir, { recursive: true });
    ticket(dir);
    progress(dir, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', 'blocked by T-8, T-9 — nothing to answer — parked']]);
  });
  after(() => rm(root));

  it('writes blockedBy, derives unblocked, notes the re-check on the stopped stage and leaves a stale lock alone', () => {
    const old = stampAgo(7 * 3600000);
    writeJson(dir, 'lock.json', { owner: 'ghost', since: old, updated: old });
    let r = state('blockers', dir, JSON.stringify([{ id: 'T-8', state: 'Done', resolved: true }, { id: 'T-9', state: 'In Progress', resolved: false }]));
    assert.deepEqual([r.code, r.json.unblocked, r.json.blockedBy.map((b) => [b.id, b.resolved, b.soft])], [0, false, [['T-8', true, false], ['T-9', false, false]]]);
    assert.ok(r.json.blockedBy.every((b) => /^\d{4}-/.test(b.checkedAt)));
    assert.deepEqual(readJson(dir, 'lock.json').updated, old);
    const st = state('state', dir).json;
    assert.deepEqual([st.unblocked, st.stopped.kind, st.stopped.resumable, st.lastEvent.event, st.lastEvent.stage], [false, 'blocked', false, 'note', 'triage']);
    assert.match(st.lastEvent.summary, /blockers re-checked: T-8 Done \(resolved\), T-9 In Progress$/);
    r = state('blockers', dir, JSON.stringify([{ id: 'T-8', state: 'Done', resolved: true }, { id: 'T-9', state: 'In Review', resolved: false, soft: true }]));
    assert.equal(r.json.unblocked, true);
    assert.equal(state('state', dir).json.stopped.resumable, true, 'soft-only blockers unblock the ticket');
    assert.match(state('state', dir).json.lastEvent.summary, /— unblocked$/);
    assert.equal(state('blockers', dir, '[{ "nope": 1 }]').code, 2);
  });

  it('records the person\'s actual hours, rounded to the half hour', () => {
    const r = state('actual', dir, JSON.stringify({ focusedHours: 5.3, source: 'person', by: 'eod' }));
    assert.deepEqual([r.code, r.json.focusedHours, r.json.source, r.json.by], [0, 5.5, 'person', 'eod']);
    assert.equal(state('state', dir).json.actual.focusedHours, 5.5);
    assert.equal(state('actual', dir, '{ "focusedHours": 0 }').code, 2);
  });
});

describe('inbox — every open stop, oldest first', () => {
  let root, work;
  before(() => {
    root = tmp(); work = join(root, 'work'); mkdirSync(work, { recursive: true });
    const a = join(work, 'A-1'); mkdirSync(a); ticket(a, undefined, { id: 'A-1', link: 'https://tracker/A-1' });
    progress(a, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'], ['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', 'which repo? api | web? Default: api']]);
    const b = join(work, 'B-2'); mkdirSync(b); ticket(b, undefined, { id: 'B-2' });
    progress(b, [['2026-01-01T09:00Z', 'start-ticket', 'started'], ['2026-01-01T09:05Z', 'start-ticket', 'stopped', 'error: clone failed — load the key — resume: /tp-run-ticket B-2 answers=retry']]);
    const c = join(work, 'C-3'); mkdirSync(c); ticket(c, undefined, { id: 'C-3' });
    progress(c, [['2026-01-01T11:00Z', 'start-ticket', 'started'], ['2026-01-01T11:05Z', 'start-ticket', 'done', 'x']]); // done but ticket.md present, triage pending: no stop
    const d = join(work, 'D-4'); mkdirSync(d); ticket(d, undefined, { id: 'D-4' });
    progress(d, [['2026-01-01T08:00Z', 'start-ticket', 'started'], ['2026-01-01T08:05Z', 'start-ticket', 'done', 'x']]);
    rmSync(join(d, 'ticket.md')); // a problem: start-ticket is done but its artefact is missing
  });
  after(() => rm(root));

  it('lists stops and problems with kind, waiting time, resume and link; a healthy ticket is absent', () => {
    const items = state('inbox', work).json;
    assert.deepEqual(items.map((i) => [i.id, i.kind]), [['D-4', 'problem'], ['B-2', 'error'], ['A-1', 'question']]);
    const a = items.find((i) => i.id === 'A-1');
    assert.deepEqual([a.stage, a.default, a.resume, a.link, a.answer], ['triage', 'api', '/tp-run-ticket A-1 answers="api"', 'https://tracker/A-1', null]);
    assert.ok(a.waitingMin > 0);
    const b = items.find((i) => i.id === 'B-2');
    assert.deepEqual([b.needs, b.resume], ['load the key', '/tp-run-ticket B-2 answers=retry']);
    const d = items.find((i) => i.id === 'D-4');
    assert.match(d.question, /ticket.md is missing/);
    assert.equal(d.resume, '/tp-run-ticket D-4 answers=retry');
  });
});
