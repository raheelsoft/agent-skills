// shape.mjs — `state.mjs shape <artifact>`: the form `put` accepts in a few lines, so a writer does not read a schema file to learn it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from './helpers.mjs';
import { ARTIFACTS, SCHEMA_DIR, loadSchema } from '../lib/contract/index.mjs';
import { shapeOf, catalogue, RULES } from '../lib/contract/shape.mjs';

describe('shape.mjs — the short form of each artifact', () => {
  it('names every required field plainly and every optional one with a ?, and shows no field twice or one `put` does not take', () => {
    for (const a of ARTIFACTS) {
      const schema = loadSchema(a);
      const shape = shapeOf(a);
      const required = new Set(schema.required || []);
      for (const key of Object.keys(schema.properties || {})) {
        if (key === 'schemaVersion') { assert.doesNotMatch(shape, /^\s+schemaVersion\??:/m, `${a}: stamped, not written`); continue; }
        assert.match(shape, new RegExp(`^  ${key}${required.has(key) ? '' : '\\?'}: `, 'm'), `${a}.${key}`);
      }
      assert.match(shape, new RegExp(`put <workdir> ${a} '<json>'`), `${a}: says how it is written`);
    }
  });

  it('shows what a write accepts and nothing an earlier run wrote: the legacy branches are left out', () => {
    const implement = shapeOf('implement');
    assert.match(implement, /^  done: integer ≥ 0$/m, 'a count, not the boolean an old run wrote');
    assert.match(implement, /complexity: "low" \| "medium" \| "high" \| "higher"/);
    assert.doesNotMatch(implement, /boolean/);
    assert.match(shapeOf('triage'), /decision: "direct" \| "plan"/);
  });

  it('adds the rules across fields that no schema can say, for the artifacts that have them', () => {
    for (const a of ['plan', 'implement', 'accept', 'pr']) assert.match(shapeOf(a), new RegExp(`^rules: ${RULES[a][0].slice(0, 20)}`, 'm'), a);
    assert.doesNotMatch(shapeOf('ticket'), /^rules:/m);
  });

  it('is short: under 2,500 characters and no more than four fifths of the schema file it comes from', () => {
    for (const a of ARTIFACTS) {
      const size = readFileSync(join(SCHEMA_DIR, `${a}.schema.json`), 'utf8').length;
      assert.ok(shapeOf(a).length <= 2500 && shapeOf(a).length <= size * 0.8, `${a}: ${shapeOf(a).length} chars against a schema of ${size}`);
    }
  });

  it('lists the artifacts with a line each, and refuses a name that is none', () => {
    assert.equal(catalogue().split('\n').length, ARTIFACTS.length);
    assert.throws(() => shapeOf('nope'), /not an artifact: nope/);
  });
});

describe('state.mjs shape — the command', () => {
  const shape = (...args) => spawnSync(process.execPath, [STATE, 'shape', ...args], { encoding: 'utf8' });
  it('prints an artifact, with a repo suffix or the file name read as the artifact, or the list', () => {
    assert.match(shape('implement').stdout, /^implement — /);
    assert.match(shape('implement.shop-web').stdout, /^implement — /);
    assert.match(shape('triage.json').stdout, /^triage — /);
    assert.equal(shape().stdout.split('\n').filter(Boolean).length, ARTIFACTS.length);
  });
  it('exits 2 with the reason for a name that is no artifact', () => {
    const r = shape('nope');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not an artifact: nope/);
  });
});
