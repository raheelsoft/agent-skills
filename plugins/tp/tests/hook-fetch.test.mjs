// The researcher reads documentation only from the sites the project allows, and no more pages than its budget; nobody else is touched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, writeJson } from './helpers.mjs';
import { run } from '../hooks/run.mjs';
import { hostAllowed, researchConfig } from '../hooks/handlers/fetch.mjs';

function project(t, research) {
  const root = tmp(); t.after(() => rm(root));
  const claude = join(root, '.claude'); mkdirSync(join(claude, 'work'), { recursive: true });
  writeJson(claude, 'tiers.json', { ceiling: 'sonnet', ladder: ['haiku', 'sonnet'], low: 'haiku', medium: 'sonnet', high: 'sonnet', ...(research ? { research } : {}) });
  return { root, claude, env: { CLAUDE_PROJECT_DIR: root } };
}
const fetchCall = (p, url, extra = {}) => run('fetch', JSON.stringify({ session_id: 's', cwd: p.root, hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url, prompt: 'p' }, agent_id: 'r1', agent_type: 'tp:researcher', ...extra }), p.env);
const decision = (o) => o?.hookSpecificOutput?.permissionDecision ?? null;
const reason = (o) => o?.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('fetch — what the researcher may read', () => {
  it('allows a page of an allowed site, outright, and says which page of the budget it is', async (t) => {
    const p = project(t, { allow: ['docs.example-orm.dev'] });
    const out = await fetchCall(p, 'https://docs.example-orm.dev/pagination#cursor');
    assert.equal(decision(out), 'allow');
    assert.match(reason(out), /docs\.example-orm\.dev is an allowed documentation site \(1 of 8\)/);
  });

  it('a subdomain of an allowed domain is allowed, a look-alike is not', async (t) => {
    const p = project(t, { allow: ['example.dev'] });
    assert.equal(decision(await fetchCall(p, 'https://docs.example.dev/x')), 'allow');
    assert.equal(decision(await fetchCall(p, 'https://example.dev/x')), 'allow');
    for (const url of ['https://notexample.dev/x', 'https://example.dev.evil.com/x', 'https://evil.com/?u=example.dev', 'https://example.devx/x']) assert.equal(decision(await fetchCall(p, url)), 'deny', url);
  });

  it('entries may be written as URLs or in capitals', async (t) => {
    assert.deepEqual(researchConfig({ claudeDir: project(t, { allow: ['https://Docs.Example.dev/', 'EXAMPLE.org'] }).claude }).allow, ['docs.example.dev', 'example.org']);
  });

  it('refuses http, credentials in the address, and what is not a URL', async (t) => {
    const p = project(t, { allow: ['example.dev'] });
    assert.match(reason(await fetchCall(p, 'http://example.dev/x')), /https pages, with no credentials/);
    assert.match(reason(await fetchCall(p, 'https://user:pw@example.dev/x')), /no credentials/);
    assert.match(reason(await fetchCall(p, 'not a url')), /not a URL/);
  });

  it('names the allowed sites when it refuses another', async (t) => {
    const out = await fetchCall(project(t, { allow: ['example.dev', 'example.org'] }), 'https://evil.com/x');
    assert.match(reason(out), /evil\.com is not one of the sites research may read \(example\.dev, example\.org\)/);
  });

  it('no allow list means no web: the researcher works from the codebase', async (t) => {
    for (const research of [undefined, { allow: [] }]) assert.match(reason(await fetchCall(project(t, research), 'https://example.dev/x')), /no documentation site is allowed for research/);
  });

  it('never searches the web', async (t) => {
    const p = project(t, { allow: ['example.dev'] });
    const out = await run('fetch', JSON.stringify({ session_id: 's', cwd: p.root, hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' }, agent_id: 'r1', agent_type: 'tp:researcher' }), p.env);
    assert.match(reason(out), /does not search the web/);
  });
});

describe('fetch — the budget', () => {
  it('allows research.maxFetches pages (8 by default), then refuses, and counts each agent on its own', async (t) => {
    const p = project(t, { allow: ['example.dev'], maxFetches: 3 });
    for (let n = 1; n <= 3; n++) assert.equal(decision(await fetchCall(p, `https://example.dev/${n}`)), 'allow', `page ${n}`);
    const over = await fetchCall(p, 'https://example.dev/4');
    assert.equal(decision(over), 'deny');
    assert.match(reason(over), /3 pages read already, the most research may read/);
    assert.equal(decision(await fetchCall(p, 'https://example.dev/1', { agent_id: 'r2' })), 'allow', 'another agent has its own budget');
    assert.equal(researchConfig({ claudeDir: project(t, { allow: ['x.dev'] }).claude }).maxFetches, 8);
  });

  it('a refused page does not use up the budget', async (t) => {
    const p = project(t, { allow: ['example.dev'], maxFetches: 1 });
    await fetchCall(p, 'https://evil.com/x');
    assert.equal(decision(await fetchCall(p, 'https://example.dev/1')), 'allow');
  });
});

describe('fetch — whose reads these are', () => {
  it('only the researcher\'s: the person\'s own session, another agent, another tool', async (t) => {
    const p = project(t, { allow: ['example.dev'] });
    assert.equal(await fetchCall(p, 'https://evil.com/x', { agent_id: undefined, agent_type: undefined }), null);
    assert.equal(await fetchCall(p, 'https://evil.com/x', { agent_type: 'tp:plan-checker' }), null);
    assert.equal(await fetchCall(p, 'https://evil.com/x', { tool_name: 'Read' }), null);
  });

  it('only in a project that ran /tp:setup', async (t) => {
    const p = project(t, { allow: [] });
    rm(join(p.claude, 'tiers.json'));
    assert.equal(await fetchCall(p, 'https://evil.com/x'), null);
  });

  it('a finished agent\'s count is cleared by the stop gate', async (t) => {
    const p = project(t, { allow: ['example.dev'] });
    await fetchCall(p, 'https://example.dev/1');
    const dir = join(p.claude, 'work', '_gates');
    assert.deepEqual(readdirSync(dir), ['r1.fetches.json']);
    const wd = join(p.claude, 'work', 'T-1'); mkdirSync(wd, { recursive: true });
    writeJson(wd, 'research.json', { questions: ['q'], findings: [], unknowns: [], confidence: 'low' });
    const transcript = join(p.root, 't.jsonl');
    (await import('node:fs')).writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: `Work directory: ${wd}.` }, timestamp: new Date(Date.now() - 5000).toISOString() }) + '\n');
    await run('subagent-stop', JSON.stringify({ session_id: 's', cwd: p.root, hook_event_name: 'SubagentStop', agent_id: 'r1', agent_type: 'tp:researcher', agent_transcript_path: transcript, last_assistant_message: 'done\ncomplexity: as rated\ncontinue: no' }), p.env);
    assert.equal(existsSync(join(dir, 'r1.fetches.json')), false);
  });
});

describe('hostAllowed', () => {
  it('is the host or a subdomain of a listed domain', () => {
    assert.equal(hostAllowed('a.b.example.dev', ['example.dev']), true);
    assert.equal(hostAllowed('example.dev', ['example.dev']), true);
    assert.equal(hostAllowed('xexample.dev', ['example.dev']), false);
    assert.equal(hostAllowed('example.dev', []), false);
  });
});
