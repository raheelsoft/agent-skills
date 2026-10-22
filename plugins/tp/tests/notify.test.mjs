// notify.mjs — what /tp:notify would send, decided by the script.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { script, tmp, rm, writeJson } from './helpers.mjs';
import { prepare } from '../lib/notify.mjs';

const CONF = { tool: 'mcp__slack__send', target: '#dev', project: 'shop', levels: ['stop', 'done', 'error'] };

describe('notify prepare', () => {
  it('builds the one line for a configured channel and a sent level', () => {
    assert.deepEqual(prepare(CONF, 'stop', 'T-1 · plan · approval needed — see work/T-1/plan.md'), { send: true, tool: 'mcp__slack__send', target: '#dev', message: '[shop] T-1 · plan · approval needed — see work/T-1/plan.md' });
  });
  it('says why nothing is sent: no file, no tool, no channel, a muted level', () => {
    assert.deepEqual(prepare(null, 'stop', 'x'), { send: false, result: 'notifications off' });
    assert.equal(prepare({ ...CONF, tool: null }, 'stop', 'x').result, 'notifications off');
    assert.match(prepare({ ...CONF, target: null }, 'stop', 'x').result, /channel not set/);
    assert.equal(prepare(CONF, 'info', 'x').result, 'notifications: info muted');
    assert.equal(prepare(CONF, 'bogus', 'x').result, 'notifications: info muted', 'an unknown level is info');
    assert.equal(prepare({ tool: 't', target: 'c' }, 'error', 'x').send, true, 'levels default to stop, done and error');
  });
  it('keeps the message to one line of a bounded length', () => {
    const m = prepare(CONF, 'done', `a\n\nb ${'x'.repeat(500)}`).message;
    assert.ok(!m.includes('\n')); assert.ok(m.length <= 300 + '[shop] '.length); assert.ok(m.endsWith('…'));
  });
  it('the command reads <.claude>/notify.json', (t) => {
    const root = tmp('notify-'); t.after(() => rm(root));
    writeJson(root, 'notify.json', CONF);
    const r = spawnSync(process.execPath, [script('notify.mjs'), 'prepare', root, 'done', 'T-1', 'done', 'PR', 'up'], { encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).message, '[shop] T-1 done PR up');
    assert.equal(JSON.parse(spawnSync(process.execPath, [script('notify.mjs'), 'prepare', join(root, 'none'), 'done', 'x'], { encoding: 'utf8' }).stdout).result, 'notifications off');
    assert.equal(spawnSync(process.execPath, [script('notify.mjs')], { encoding: 'utf8' }).status, 2);
  });
});
