// The plugin's Claude Code hooks (hooks/): what each handler decides from a real payload, the runner that must never break a session, and the
// registration that must only name handlers that exist. Payload fixtures are shapes recorded from Claude Code itself (tests/fixtures/hooks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, tmp, rm, writeJson } from './helpers.mjs';
import { run } from '../hooks/run.mjs';

const HOOKS = join(PLUGIN_ROOT, 'hooks');
const fixture = (name) => JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'hooks', `${name}.json`), 'utf8'));
const expansion = (command) => ({ ...fixture('user-prompt-expansion'), command_name: command, prompt: `/${command}` });
/** A project whose pipeline.json turns `off` skills off; the hook finds it through $CLAUDE_PROJECT_DIR, as it does in a session. */
function project(t, off = []) {
  const root = tmp(); t.after(() => rm(root));
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (off.length) writeJson(join(root, '.claude'), 'pipeline.json', { skills: Object.fromEntries(off.map((n) => [n, false])), setAt: 'x', by: 'test' });
  return root;
}
const cli = (handler, input, env = {}) => {
  const r = spawnSync(process.execPath, [join(HOOKS, 'run.mjs'), handler], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('hooks — the recorded payloads', () => {
  it('every fixture is a real payload shape: session, event name and the fields a handler reads', () => {
    for (const f of readdirSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'hooks'))) {
      const p = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'hooks', f), 'utf8'));
      assert.ok(p.hook_event_name && p.session_id && p.cwd, `${f} names its event, session and cwd`);
    }
    assert.deepEqual([fixture('user-prompt-expansion').expansion_type, fixture('user-prompt-expansion').command_source], ['slash_command', 'plugin']);
    for (const k of ['last_assistant_message', 'stop_hook_active', 'agent_id', 'agent_type', 'agent_transcript_path']) assert.ok(k in fixture('subagent-stop'), `SubagentStop carries ${k}`);
    assert.ok(!('model' in fixture('session-start')), 'SessionStart carries no model: a hook that needs it reads the transcript');
  });
});

describe('hooks — off-skill', () => {
  it('blocks a typed skill the project turned off, with the way back', async (t) => {
    const root = project(t, ['merge']);
    const out = await run('off-skill', JSON.stringify(expansion('tp:merge')), { CLAUDE_PROJECT_DIR: root });
    assert.deepEqual(out, { decision: 'block', reason: '/tp:merge is off in this project (.claude/pipeline.json). /tp:setup turns it back on.' });
  });

  it('lets through a skill that is on, a command that is not the pipeline\'s, setup itself, and an unknown name', async (t) => {
    const root = project(t, ['merge']);
    const env = { CLAUDE_PROJECT_DIR: root };
    for (const command of ['tp:status', 'other:merge', 'merge', 'tp:setup', 'tp:no-such-skill']) assert.equal(await run('off-skill', JSON.stringify(expansion(command)), env), null, command);
    assert.equal(await run('off-skill', JSON.stringify({ ...expansion('tp:merge'), expansion_type: 'mcp_prompt' }), env), null, 'only a typed slash command');
  });

  it('is silent in a project with no pipeline.json — every skill is on there — and outside any project', async (t) => {
    assert.equal(await run('off-skill', JSON.stringify(expansion('tp:merge')), { CLAUDE_PROJECT_DIR: project(t) }), null);
    assert.equal(await run('off-skill', JSON.stringify(expansion('tp:merge')), { CLAUDE_PROJECT_DIR: join(tmp(), 'nowhere') }), null);
  });

  it('reads an older pipeline.json that spells the skill with the old prefix', async (t) => {
    const root = tmp(); t.after(() => rm(root)); mkdirSync(join(root, '.claude'), { recursive: true });
    writeJson(join(root, '.claude'), 'pipeline.json', { skills: { 'tp-merge': false }, setAt: 'x', by: 'an older install' });
    assert.equal((await run('off-skill', JSON.stringify(expansion('tp:merge')), { CLAUDE_PROJECT_DIR: root })).decision, 'block');
  });
});

describe('hooks — the runner never breaks a session', () => {
  it('prints a handler\'s decision as JSON and exits 0', (t) => {
    const r = cli('off-skill', expansion('tp:merge'), { CLAUDE_PROJECT_DIR: project(t, ['merge']) });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).decision, 'block');
  });

  it('exits 0 and prints nothing for a payload it cannot read, a handler that does not exist, or a name that is not one', (t) => {
    const env = { CLAUDE_PROJECT_DIR: project(t, ['merge']) };
    assert.deepEqual(cli('off-skill', '{ not json', env), { code: 0, out: '', err: '' });
    for (const name of ['no-such-handler', '../lib/setup', 'a/b', '']) {
      const r = cli(name, expansion('tp:merge'), env);
      assert.equal(r.code, 0, `"${name}" must not break the session`);
      assert.equal(r.out, '');
      assert.match(r.err, /let through/, `"${name}" leaves a note`);
    }
  });

  it('exits 0 with a note when the handler itself fails', (t) => {
    const root = project(t, []);
    writeJson(join(root, '.claude'), 'pipeline.json', 'null'); // a file the handler's reader tolerates…
    const r = cli('off-skill', { ...expansion('tp:merge'), command_name: { toString() { throw new Error('boom'); } } }, { CLAUDE_PROJECT_DIR: root });
    assert.equal(r.code, 0);
  });
});

describe('hooks — the registration', () => {
  const registry = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  const entries = Object.entries(registry).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, ...h }))));

  it('every hook runs the one runner in exec form, from the plugin, with a handler that exists and a timeout', () => {
    assert.ok(entries.length >= 1);
    for (const e of entries) {
      assert.equal(e.type, 'command');
      assert.equal(e.command, 'node', `${e.event}: exec form — no shell, no quoting`);
      assert.equal(e.args[0], '${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs', `${e.event} runs the runner`);
      assert.ok(existsSync(join(HOOKS, 'handlers', `${e.args[1]}.mjs`)), `${e.event}: handler ${e.args[1]} exists`);
      assert.ok(e.timeout > 0 && e.timeout <= 60, `${e.event}: an explicit, short timeout`);
    }
  });

  it('every handler is registered, and every matcher is a valid pattern', () => {
    const files = readdirSync(join(HOOKS, 'handlers')).map((f) => f.replace(/\.mjs$/, '')).sort();
    assert.deepEqual([...new Set(entries.map((e) => e.args[1]))].sort(), files, 'no handler sits unregistered');
    for (const e of entries) if (e.matcher) assert.doesNotThrow(() => new RegExp(e.matcher), `${e.event}: ${e.matcher}`);
  });
});
