// The schema validator: the subset of JSON Schema the pipeline's schemas use, in both modes, with messages a model can act on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate, unsupportedKeywords, SUPPORTED } from '../lib/contract/schema.mjs';

const ok = (schema, value, opts) => assert.deepEqual(validate(schema, value, opts), [], JSON.stringify(value));
const bad = (schema, value, expected, opts) => {
  const errors = validate(schema, value, opts);
  assert.ok(errors.length, `${JSON.stringify(value)} should be refused`);
  assert.ok(errors.some((e) => e.includes(expected)), `${JSON.stringify(errors)} should mention "${expected}"`);
};

describe('validate — types and values', () => {
  it('checks type, with integer inside number and null as its own type', () => {
    ok({ type: 'integer' }, 3);
    ok({ type: 'number' }, 3.5);
    ok({ type: ['string', 'null'] }, null);
    bad({ type: 'integer' }, 3.5, '$: expected integer, got number');
    bad({ type: 'string' }, 7, 'expected string, got integer');
    bad({ type: 'object' }, [], 'expected object, got array');
    bad({ type: 'array' }, null, 'expected array, got null');
  });

  it('checks enum and const by value, and says what was allowed', () => {
    ok({ enum: ['a', 'b'] }, 'b');
    bad({ enum: ['a', 'b'] }, 'c', 'expected one of "a" | "b", got "c"');
    ok({ const: 1 }, 1);
    bad({ const: 1 }, 2, 'expected 1, got 2');
  });

  it('checks string length and pattern, number range', () => {
    bad({ type: 'string', minLength: 2 }, 'a', 'shorter than 2');
    bad({ type: 'string', maxLength: 2 }, 'abc', 'longer than 2 characters (3)');
    bad({ type: 'string', pattern: '^/' }, 'rel', 'does not match ^/');
    ok({ type: 'string', pattern: '^/' }, '/abs');
    bad({ type: 'integer', minimum: 1 }, 0, 'is below 1');
    bad({ type: 'integer', maximum: 5 }, 6, 'is above 5');
  });
});

describe('validate — objects and arrays', () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } } };

  it('requires keys, types the ones it knows and lets the others through', () => {
    ok(schema, { id: 'x', extra: 1 });
    bad(schema, {}, '$.id: required, missing');
    bad(schema, { id: 1 }, '$.id: expected string, got integer');
  });

  it('reports the path to the item that is wrong', () => {
    bad(schema, { id: 'x', tags: ['a', 2] }, '$.tags[1]: expected string, got integer');
    bad(schema, { id: 'x', tags: [] }, 'needs at least 1 item');
    bad(schema, { id: 'x', tags: ['a', 'b', 'c'] }, 'at most 2 item');
  });

  it('additionalProperties: false forbids the unknown, a schema types them', () => {
    bad({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 }, '$.b: not allowed here');
    ok({ type: 'object', additionalProperties: { type: 'string' } }, { x: 'a', y: 'b' });
    bad({ type: 'object', additionalProperties: { type: 'string' } }, { x: 'a', y: 1 }, '$.y: expected string');
  });

  it('writes a key that is not an identifier as ["key"]', () => {
    bad({ type: 'object', properties: { 'a b': { type: 'string' } } }, { 'a b': 1 }, '$["a b"]: expected string');
  });
});

describe('validate — combinators', () => {
  it('anyOf passes when one branch does, and names the options when none does', () => {
    const s = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
    ok(s, 3); ok(s, null);
    bad(s, 'x', 'expected integer | null, got "x"');
  });

  it('anyOf with a single live branch reports that branch\'s own errors', () => {
    const s = { anyOf: [{ type: 'object', required: ['a'] }, { type: 'object', 'x-legacy': true }] };
    bad(s, {}, '$.a: required, missing');
  });

  it('allOf checks every part', () => {
    const s = { allOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] };
    bad(s, { a: 1 }, '$.b: required, missing');
  });

  it('if / then / else picks the rule by the value', () => {
    const s = { if: { required: ['k'], properties: { k: { const: 'x' } } }, then: { required: ['need'] }, else: { required: ['other'] } };
    ok(s, { k: 'x', need: 1 });
    bad(s, { k: 'x' }, '$.need: required');
    ok(s, { k: 'y', other: 1 });
    bad(s, { k: 'y' }, '$.other: required');
  });
});

describe('validate — the two modes', () => {
  const count = { anyOf: [{ type: 'integer' }, { type: 'array', 'x-legacy': true }] };

  it('a legacy branch is accepted when reading and refused when writing', () => {
    ok(count, [1, 2], { mode: 'read' });
    bad(count, [1, 2], '$: expected integer, got array', { mode: 'write' });
    ok(count, 3, { mode: 'write' });
  });

  it('writing is the default', () => {
    bad(count, [1], 'expected integer');
  });

  it('x-legacy-optional relaxes a required key when reading only', () => {
    const s = { type: 'object', required: ['a', 'b'], 'x-legacy-optional': ['b'] };
    ok(s, { a: 1 }, { mode: 'read' });
    bad(s, { a: 1 }, '$.b: required, missing', { mode: 'write' });
    bad(s, { b: 1 }, '$.a: required, missing', { mode: 'read' });
  });
});

describe('validate — $ref', () => {
  const files = { 'common.schema.json': { $defs: { rating: { enum: ['low', 'high'] } } } };
  const load = (f) => files[f];

  it('follows a local pointer and a pointer into another file', () => {
    const s = { $defs: { n: { type: 'integer' } }, type: 'object', properties: { a: { $ref: '#/$defs/n' }, r: { $ref: 'common.schema.json#/$defs/rating' } } };
    ok(s, { a: 1, r: 'low' }, { load });
    bad(s, { a: 'x' }, '$.a: expected integer', { load });
    bad(s, { r: 'mid' }, '$.r: expected one of "low" | "high"', { load });
  });

  it('reports a reference that does not resolve instead of passing', () => {
    bad({ $ref: '#/$defs/missing' }, 1, 'unresolvable $ref', { load });
  });
});

describe('unsupportedKeywords', () => {
  it('lists an assertion the validator would ignore', () => {
    assert.deepEqual(unsupportedKeywords({ type: 'object', properties: { a: { type: 'string', format: 'email', uniqueItems: true } } }).sort(), ['format', 'uniqueItems']);
  });

  it('does not mistake a property called like a keyword for the keyword', () => {
    assert.deepEqual(unsupportedKeywords({ type: 'object', properties: { type: { type: 'string' }, not: { type: 'string' } } }), []);
  });

  it('knows the keywords it supports', () => {
    assert.ok(['type', 'enum', 'anyOf', 'if', '$ref'].every((k) => SUPPORTED.has(k)));
  });
});
