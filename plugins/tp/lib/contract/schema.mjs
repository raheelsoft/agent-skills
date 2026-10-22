// schema.mjs — the validator the work directory's contracts are checked with: the subset of JSON Schema the pipeline's schemas use, with no
// dependency and no file access (a `$ref` into another file goes through the `load` function the caller passes). It returns error lines
// — `$.reviews[1].verdict: expected one of PASS | BLOCK, got "WARN"` — never throws on a value, so a hook, a command and a test read the
// same text. A keyword outside SUPPORTED never silently passes: the schema tests refuse a schema that uses one.
//
// Two modes, one schema (schemas/README.md):
//   write  the contract as it is today — what `state.mjs put` enforces on every new artifact;
//   read   what the readers tolerate — also accepts the branches marked `"x-legacy": true` (a shape an earlier pipeline wrote and the
//          state script still reads) and does not insist on a key listed in the schema's `"x-legacy-optional"`.

/** Keywords that assert something; the schema tests compare every schema in schemas/ against this list. */
export const SUPPORTED = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf', 'allOf', 'if', 'then', 'else', '$ref',
]);
/** Keywords that only describe or steer the validator; ignored on purpose. */
export const ANNOTATIONS = new Set(['$schema', '$id', '$comment', '$defs', 'title', 'description', 'examples', 'default', 'x-legacy', 'x-legacy-optional']);

const MAX_DEPTH = 40;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matchesType = (t, v) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);
const show = (v) => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s; };
const at = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_][\w-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/** A schema's shape in a few words, for "expected …" messages. */
export function describe(schema) {
  if (!schema || typeof schema !== 'object') return 'anything';
  if (schema.$ref) return String(schema.$ref).split('/').pop();
  if ('const' in schema) return show(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(show).join(' | ');
  if (schema.type) return [].concat(schema.type).join(' or ');
  if (schema.properties || schema.required) return 'object';
  if (schema.anyOf) return schema.anyOf.map(describe).join(' | ');
  return 'a value';
}

/**
 * Check `value` against `schema`. Options: mode ('write' default | 'read'); load(file) -> the parsed schema file, for `$ref`s that name one.
 * Returns the error lines, empty when the value conforms.
 */
export function validate(schema, value, { mode = 'write', load = () => { throw new Error('no schema loader'); } } = {}) {
  const errors = [];
  const read = mode === 'read';
  const root = { schema, file: null };

  const resolve = (ref, scope) => {
    const [file, pointer = ''] = ref.split('#');
    const owner = file ? { schema: load(file), file } : scope;
    let node = owner.schema;
    for (const part of pointer.split('/').filter(Boolean)) {
      node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
    }
    return { schema: node, scope: owner };
  };

  // the errors one branch gives, without touching the caller's list
  const attempt = (s, v, path, scope, depth) => {
    const saved = errors.length;
    walk(s, v, path, scope, depth);
    return errors.splice(saved);
  };

  function walk(s, v, path, scope, depth) {
    if (depth > MAX_DEPTH) { errors.push(`${path}: schema nesting too deep`); return; }
    if (!s || typeof s !== 'object') return;
    if (s.$ref) { const r = resolve(s.$ref, scope); walk(r.schema, v, path, r.scope, depth + 1); }

    if (s.type !== undefined) {
      const types = [].concat(s.type);
      if (!types.some((t) => matchesType(t, v))) { errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(v)}`); return; }
    }
    if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) errors.push(`${path}: expected ${show(s.const)}, got ${show(v)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: expected one of ${s.enum.map(show).join(' | ')}, got ${show(v)}`);

    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength} characters`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength} characters (${v.length})`);
      if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) errors.push(`${path}: ${show(v)} does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: ${v} is below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: ${v} is above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: needs at least ${s.minItems} item(s), has ${v.length}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: at most ${s.maxItems} item(s), has ${v.length}`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, at(path, i), scope, depth + 1));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const optional = read && Array.isArray(s['x-legacy-optional']) ? s['x-legacy-optional'] : [];
      for (const key of s.required || []) if (!(key in v) && !optional.includes(key)) errors.push(`${at(path, key)}: required, missing`);
      const known = s.properties || {};
      for (const [key, item] of Object.entries(v)) {
        if (key in known) walk(known[key], item, at(path, key), scope, depth + 1);
        else if (s.additionalProperties === false) errors.push(`${at(path, key)}: not allowed here`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, item, at(path, key), scope, depth + 1);
      }
    }

    if (Array.isArray(s.allOf)) for (const part of s.allOf) walk(part, v, path, scope, depth + 1);
    if (s.if) {
      const holds = attempt(s.if, v, path, scope, depth + 1).length === 0;
      if (holds && s.then) walk(s.then, v, path, scope, depth + 1);
      if (!holds && s.else) walk(s.else, v, path, scope, depth + 1);
    }
    if (Array.isArray(s.anyOf)) {
      const branches = s.anyOf.filter((b) => read || !(b && b['x-legacy'] === true));
      if (!branches.length) return;
      const failures = [];
      for (const b of branches) {
        const got = attempt(b, v, path, scope, depth + 1);
        if (!got.length) return;
        failures.push(got);
      }
      // a branch whose type fits the value is the one the author meant: report what is wrong inside it, not a list of everything it could have been
      const wrongType = (list) => list.some((e) => e.startsWith(`${path}: expected `) && !e.startsWith(`${path}: expected one of`) && e.includes(', got '));
      const near = failures.filter((f) => !wrongType(f)).sort((a, b) => a.length - b.length);
      if (near.length) errors.push(...near[0]);
      else if (failures.length === 1) errors.push(...failures[0]);
      else errors.push(`${path}: expected ${branches.map(describe).join(' | ')}, got ${show(v)}`);
    }
  }

  try { walk(root.schema, value, '$', root, 0); } catch (e) { errors.push(`$: ${e.message}`); }
  return errors;
}

/** The keywords a schema uses that this validator would ignore without saying so — [] when the schema is fully checked. */
export function unsupportedKeywords(schema, found = new Set()) {
  if (Array.isArray(schema)) { for (const s of schema) unsupportedKeywords(s, found); return [...found]; }
  if (!schema || typeof schema !== 'object') return [...found];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') { for (const s of Object.values(value)) unsupportedKeywords(s, found); continue; }
    if (key === '$defs') { for (const s of Object.values(value)) unsupportedKeywords(s, found); continue; }
    if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) found.add(key);
    if (['items', 'additionalProperties', 'if', 'then', 'else'].includes(key)) unsupportedKeywords(value, found);
    if (['anyOf', 'allOf'].includes(key)) unsupportedKeywords(value, found);
  }
  return [...found];
}
