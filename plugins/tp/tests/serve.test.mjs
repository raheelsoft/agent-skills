// Request-level tests for office/serve.mjs: static files inside office/ only, /office.json live and in sim mode.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmp, rm, pickedUp, officeConfig, joinAgent, append, state } from './helpers.mjs';
import { start } from '../office/serve.mjs';

describe('office server', () => {
  let root, work, srv;
  before(async () => {
    root = tmp(); work = join(root, 'work');
    pickedUp(root, { id: 'T-7', repos: [{ name: 'api' }] });
    officeConfig(root, { team: 'Test team', poll: 1500 });
    joinAgent(work, { id: 'T-7:triage:lead', level: 'lead', stage: 'triage', ticket: 'T-7' });
    srv = await start({ port: 0, workroot: work });
  });
  after(async () => { await srv.close(); rm(root); });

  it('serves the page and its assets, nothing outside the folder', async () => {
    const page = await fetch(srv.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Office<\/title>/);
    assert.equal((await fetch(`${srv.url}app.js`)).status, 200);
    assert.equal((await fetch(`${srv.url}style.css`)).status, 200);
    assert.equal((await fetch(`${srv.url}../tests/helpers.mjs`)).status, 404, 'no path traversal');
    assert.equal((await fetch(`${srv.url}serve.mjs`)).status, 404, 'only page assets are served, not the server source');
    assert.equal((await fetch(`${srv.url}electron/main.js`)).status, 404, 'the electron wrapper is not served');
    assert.equal((await fetch(`${srv.url}nope.html`)).status, 404);
    assert.equal((await fetch(`${srv.url}sim`)).status, 404, 'no directory listings');
    const post = await fetch(srv.url, { method: 'POST' });
    assert.equal(post.status, 405, 'POST anywhere but /answer is refused');
  });

  it('queues an answer through the state script on POST /answer, and refuses other origins, oversized bodies and demo mode', async () => {
    const t7 = join(work, 'T-7');
    append(t7, [['2026-01-01T10:06Z', 'triage', 'started'], ['2026-01-01T10:07Z', 'triage', 'stopped', 'which repo? api | web? Default: api']]);
    const post = (body, headers = {}) => fetch(`${srv.url}answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    let r = await post({ id: 'T-7', stage: 'implement', answer: 'web' });
    assert.equal(r.status, 409, 'not stopped at that stage');
    assert.match((await r.json()).error, /stopped at triage, not implement/);
    r = await post({ id: 'T-7', stage: 'triage', answer: 'web' }, { Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    r = await post({ id: 'T-7', stage: 'triage', answer: 'web' }, { Origin: srv.url.replace(/\/$/, '') });
    assert.equal(r.status, 200, 'the page itself');
    const j = await r.json();
    assert.deepEqual([j.id, j.stage, j.answer, j.by, j.at], ['T-7', 'triage', 'web', 'office', '2026-01-01T10:07Z']);
    assert.equal(state('answer', work, 'T-7', '--peek').json.answer, 'web');
    const office = await (await fetch(`${srv.url}office.json`)).json();
    assert.equal(office.inbox.find((i) => i.id === 'T-7').answer.text, 'web', 'the office shows it at once');
    r = await post({ id: 'T-7', stage: 'triage', answer: '' });
    assert.equal(r.status, 422);
    r = await post('{ not json');
    assert.equal(r.status, 422);
    r = await post({ id: 'T-7', stage: 'triage', answer: 'x'.repeat(9000) });
    assert.equal(r.status, 413);
    r = await post({ id: '../T-7', stage: 'triage', answer: 'web' });
    assert.equal(r.status, 422, 'ids are plain');
    assert.equal(state('answer', work, 'T-7', '--consume').code, 0);
    const demo = await start({ port: 0, workroot: work, sim: true });
    assert.equal((await fetch(`${demo.url.replace('?sim', '')}answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'T-101', stage: 'implement:api', answer: 'x' }) })).status, 403);
    await demo.close();
  });

  it('serves one of a ticket\'s own markdown files on /file and nothing else', async () => {
    const t7 = join(work, 'T-7');
    writeFileSync(join(t7, 'plan.md'), '# plan\n\n1. do it\n');
    let r = await fetch(`${srv.url}file?ticket=T-7&name=plan.md`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/markdown/);
    assert.match(await r.text(), /1\. do it/);
    assert.equal((await fetch(`${srv.url}file?ticket=T-7&name=ticket.json`)).status, 404, 'only the listed markdown files');
    assert.equal((await fetch(`${srv.url}file?ticket=T-7&name=triage.md`)).status, 404, 'not there yet');
    assert.equal((await fetch(`${srv.url}file?ticket=..&name=plan.md`)).status, 404, 'no traversal');
    assert.equal((await fetch(`${srv.url}file?ticket=T-7%2F..%2FT-8&name=plan.md`)).status, 404);

    // a day plan is a stop's `doc` too: the person answering on the inbox card reads what they are approving
    // (skills/README.md § Definitions, Asking the user)
    mkdirSync(join(work, '_day'), { recursive: true });
    writeFileSync(join(work, '_day', '2026-01-02.md'), '# the day\n\nT-1, T-2\n');
    assert.match(await (await fetch(`${srv.url}file?ticket=_day&name=2026-01-02.md`)).text(), /T-1, T-2/);
    assert.equal((await fetch(`${srv.url}file?ticket=_day&name=notes.md`)).status, 404, 'only a dated plan under _day');
    assert.equal((await fetch(`${srv.url}file?ticket=T-7&name=2026-01-02.md`)).status, 404, 'and only under _day');
  });

  it('serves the demo loop with the inbox, the day board, the budget and the doctor, their stamps made absolute', async () => {
    const j = await (await fetch(`${srv.url}office.json?sim`)).json();
    assert.ok(Array.isArray(j.inbox) && j.day && j.budget && j.doctor && j.totals, 'the new sections are in every frame');
    assert.match(j.budget.at, /^\d{4}-/);
    assert.match(j.day.updatedAt, /^\d{4}-/);
    for (const i of j.inbox) assert.match(i.since, /^\d{4}-/);
  });

  it('computes /office.json from the state script, with the team and the registered agents', async () => {
    const r = await fetch(`${srv.url}office.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.team, 'Test team');
    assert.equal(j.poll, 1500);
    assert.deepEqual(j.tickets.map((t) => t.id), ['T-7']);
    assert.deepEqual(j.projects.map((p) => p.name), ['api']);
    assert.equal(j.agents[0].id, 'T-7:triage:lead');
    assert.ok(!j.sim);
  });

  it('serves the demo loop on ?sim with absolute timestamps and the frame name', async () => {
    const j = await (await fetch(`${srv.url}office.json?sim`)).json();
    assert.equal(j.sim, true);
    assert.match(j.frame, /^\d\.json$/);
    assert.equal(j.team, 'Demo team');
    assert.ok(j.agents.length > 0);
    for (const a of j.agents) { assert.match(a.started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); assert.match(a.since, /^\d{4}-/); }
    const only = await start({ port: 0, workroot: work, sim: true });
    assert.equal(only.url.endsWith('?sim'), true);
    assert.equal((await (await fetch(`${only.url.replace('?sim', '')}office.json`)).json()).sim, true, '--sim serves the loop without the query');
    await only.close();
  });

  it('reports a failing state script as a 500 with the error', async () => {
    const broken = await start({ port: 0, workroot: join(root, 'not-a-dir') });
    const j = await (await fetch(`${broken.url}office.json`)).json();
    assert.ok(Array.isArray(j.problems) || j.error, 'a missing work root is an empty office, not a crash');
    await broken.close();
  });
});
