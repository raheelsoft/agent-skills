// The shape of the scripts, held by tests: small modules with one job, a library that never prints or exits, an import graph without cycles.
// A refactor that is not enforced decays; these are the budgets the state library was split to meet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, tmp, rm, pickedUp } from './helpers.mjs';
import * as state from '../lib/state/index.mjs';

const STATE_LIB = join(PLUGIN_ROOT, 'lib', 'state');
const modules = readdirSync(STATE_LIB).filter((f) => f.endsWith('.mjs'));
const source = (f) => readFileSync(join(STATE_LIB, f), 'utf8');
/** The code of a module, without comments and string contents — what it does rather than what it says. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');

describe('the state library — the budgets', () => {
  it('every module is small enough to read in one go', () => {
    for (const f of modules) assert.ok(source(f).split('\n').length <= 400, `${f} is ${source(f).split('\n').length} lines: split it by responsibility`);
  });

  it('no library module prints, exits or reads the command line: only state.mjs, the CLI, does', () => {
    for (const f of modules) {
      const hits = [...code(source(f)).matchAll(/process\.(exit|stdout|stderr|argv)|console\.(log|error|warn)/g)].map((m) => m[0]);
      assert.deepEqual(hits, [], `${f} touches the terminal: return the text or throw a CliError instead`);
    }
  });

  it('the import graph has no cycles, and a module imports only its siblings and node', () => {
    const edges = new Map(modules.map((f) => [f, [...source(f).matchAll(/^import .* from '(\.[^']+)';/gm)].map((m) => m[1]).filter((p) => p.startsWith('./')).map((p) => p.replace('./', ''))]));
    for (const f of modules) for (const m of source(f).matchAll(/^import .* from '([^']+)';/gm)) assert.ok(m[1].startsWith('./') || m[1].startsWith('node:') || m[1].startsWith('../'), `${f} imports ${m[1]}`);
    const state_ = new Map();
    const visit = (f, path) => {
      assert.notEqual(state_.get(f), 'open', `import cycle: ${[...path, f].join(' → ')}`);
      if (state_.get(f) === 'done') return;
      state_.set(f, 'open');
      for (const d of edges.get(f) || []) if (edges.has(d)) visit(d, [...path, f]);
      state_.set(f, 'done');
    };
    for (const f of modules) visit(f, []);
  });

  it('the CLI is a shim: it imports from state/ and holds no logic of its own', () => {
    const shim = readFileSync(join(PLUGIN_ROOT, 'lib', 'state.mjs'), 'utf8');
    assert.ok(shim.split('\n').length <= 140, 'state.mjs only parses arguments, prints and exits');
    for (const m of shim.matchAll(/^import .* from '([^']+)';/gm)) assert.match(m[1], /^\.\/state\//, `the shim imports ${m[1]}`);
  });
});

describe('the state library — used from code, not only from a command line', () => {
  it('exports its public API from one place', () => {
    for (const name of ['computeState', 'brief', 'all', 'totals', 'usage', 'inbox', 'answerQueue', 'answerTake', 'log', 'lockRun', 'unlockRun', 'agentJoin', 'agentLeave', 'recordBlockers', 'recordActual', 'office']) {
      assert.equal(typeof state[name], 'function', `${name} is exported`);
    }
    assert.equal(typeof state.CliError, 'function');
  });

  it('computes a ticket\'s state in-process — what a hook does instead of spawning a script', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = pickedUp(root, { id: 'T-1' });
    const s = state.computeState(dir);
    assert.deepEqual([s.id, s.next, s.stopped], ['T-1', 'triage', null]);
    assert.deepEqual(Object.keys(state.brief(s)).sort(), ['closed', 'complexity', 'id', 'lock', 'next', 'problems', 'stopped', 'unblocked', 'worktrees']);
  });

  it('refuses with a CliError that carries the exit code, and never takes the process down', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };
    for (const [what, fn, code] of [
      ['a lock on a folder that is not there', () => state.lockRun(join(root, 'nowhere'), 'me'), 2],
      ['a log line for a missing ticket', () => state.log(join(root, 'nowhere'), 'triage', 'started', 'x'), 2],
      ['an agent that joins with the JSON where the work root belongs', () => state.agentJoin('{"id":"x"}', undefined), 2],
      ['an answer for a ticket that is not stopped (exit 3, as the command always had)', () => state.answerQueue(root, 'T-9', 'plan', 'go'), 3],
    ]) {
      const e = refusal(fn);
      assert.ok(e instanceof state.CliError, `${what} throws a CliError`);
      assert.equal(e.code, code, what);
      assert.ok(e.message, `${what} says why`);
    }
  });

  it('a lock held by someone else is exit 3, and a lock taken says so by returning the message', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = pickedUp(root, { id: 'T-2' });
    assert.equal(state.lockRun(dir, 'alice'), 'locked by alice\n');
    const e = (() => { try { state.lockRun(dir, 'bob'); } catch (x) { return x; } })();
    assert.deepEqual([e instanceof state.CliError, e.code], [true, 3]);
    assert.match(e.message, /locked by alice/);
    assert.equal(state.unlockRun(dir, 'alice'), 'unlocked (alice)\n');
  });
});
