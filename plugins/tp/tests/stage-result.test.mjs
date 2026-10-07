// One stage result for every stage agent: the workflow hands the runtime a copy of the schema's shape; this keeps the copy and the file equal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORKFLOW } from './helpers.mjs';
import { loadSchema, validate } from '../lib/contract/index.mjs';

const source = readFileSync(WORKFLOW, 'utf8');
/** The workflow's own `const STAGE = { … }` literal, evaluated. */
function inlineStage() {
  const start = source.indexOf('const STAGE = ');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start, 'the workflow declares const STAGE');
  return new Function(`return (${source.slice(start + 'const STAGE = '.length, end)})`)();
}

describe('stage-result', () => {
  it('the workflow\'s inline schema has the same properties and required keys as schemas/stage-result.schema.json', () => {
    const file = loadSchema('stage-result');
    const inline = inlineStage();
    assert.deepEqual(inline.properties, file.properties);
    assert.deepEqual(inline.required, file.required);
    assert.equal(inline.type, file.type);
  });

  it('every status the workflow acts on is one the schema allows', () => {
    const allowed = loadSchema('stage-result').properties.status.enum;
    const used = new Set([...source.matchAll(/status === '(\w+)'|status: '(\w+)'|status !== '(\w+)'/g)].map((m) => m[1] || m[2] || m[3]));
    for (const s of used) assert.ok(allowed.includes(s) || s === 'needs_input', `${s} is a status the workflow uses`);
  });

  it('a stage result is valid when it is the workflow\'s own returns', () => {
    const s = loadSchema('stage-result');
    const rows = [
      { status: 'done', summary: 'triage: direct', data: { id: 'T-1', next: 'implement' } },
      { status: 'stopped', summary: 'plan: approval', question: 'approve (go-ahead) or send a change', data: {} },
      { status: 'error', summary: 'x', diagnosis: 'd', resume: 'r', needs: 'none', data: {} },
      { status: 'continue', summary: 'checkpointed at step 3', data: {}, escalate: false },
    ];
    for (const r of rows) assert.deepEqual(validate(s, r, { load: loadSchema }), [], JSON.stringify(r));
  });

  it('refuses what the downstream code cannot route on', () => {
    const s = loadSchema('stage-result');
    const refuse = (r, expected) => assert.ok(validate(s, r, { load: loadSchema }).some((e) => e.includes(expected)), `${JSON.stringify(r)} → ${expected}`);
    refuse({ status: 'stopped', summary: 'x', data: {} }, '$.question: required');
    refuse({ status: 'error', summary: 'x', data: {} }, '$.diagnosis: required');
    refuse({ status: 'finished', summary: 'x', data: {} }, '$.status');
    refuse({ status: 'done', data: {} }, '$.summary: required');
    refuse({ status: 'done', summary: 'x' }, '$.data: required');
    refuse({ status: 'done', summary: 'x', data: [] }, '$.data: expected object');
  });
});
