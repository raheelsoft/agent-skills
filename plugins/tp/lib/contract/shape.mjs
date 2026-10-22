// shape.mjs — a schema as the short form a writer needs: every field with its type, the values it may take and the schema's own line of guidance, in
// a few hundred tokens instead of the schema file's few thousand (`state.mjs shape <artifact>`). Only the shape `put` accepts is shown — a branch
// marked x-legacy is one earlier runs wrote and is refused on a write — and the rules across fields that no schema can say are listed under it.
import { ARTIFACTS, loadSchema } from './registry.mjs';

/** The rules `invariants.mjs` checks after the shape, in words, for the artifacts that have any. */
export const RULES = {
  plan: ['status "ready" needs openQuestions 0; "open-questions" needs more than 0'],
  implement: ['done is at most total'],
  accept: ['passed, failed and manual equal the number of criteria whose result is pass, fail, manual'],
  pr: ['a merged pull request has a verdict'],
};

function deref(ref, root) {
  const [file, pointer = ''] = ref.split('#');
  let node = file ? loadSchema(file) : root;
  for (const key of pointer.split('/').filter(Boolean)) node = node?.[key];
  return node || {};
}

/** A description's first sentence, at most 140 characters. */
const first = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.;])(\s|$)/.exec(s);
  const t = m ? m[1] : s;
  return t.length > 140 ? `${t.slice(0, 137)}…` : t;
};

/** One schema node as a type expression; objects become indented blocks. */
function render(node, root, depth = 0) {
  if (node.$ref) return render({ ...deref(node.$ref, root), ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) }, root, depth);
  const branches = node.anyOf || node.oneOf;
  if (branches) {
    const live = branches.filter((b) => !b['x-legacy']);
    return [...new Set(live.map((b) => render(b, root, depth)))].join(' | ') || 'any';
  }
  if ('const' in node) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  const types = [].concat(node.type || []);
  if (types.length > 1) return types.join(' | ');
  switch (types[0]) {
    case 'string': return node.pattern ? `string /${node.pattern}/` : 'string';
    case 'integer': case 'number': return `${types[0]}${typeof node.minimum === 'number' ? ` ≥ ${node.minimum}` : ''}${typeof node.maximum === 'number' ? ` ≤ ${node.maximum}` : ''}`;
    case 'boolean': case 'null': return types[0];
    case 'array': return `[${node.items ? render(node.items, root, depth) : 'any'}]`;
    case 'object': return block(node, root, depth);
    default: return node.properties ? block(node, root, depth) : 'any';
  }
}

function block(node, root, depth) {
  const props = Object.entries(node.properties || {}).filter(([k]) => k !== 'schemaVersion');
  const required = new Set(node.required || []);
  if (!props.length) {
    const extra = node.additionalProperties && typeof node.additionalProperties === 'object' ? render(node.additionalProperties, root, depth) : 'any';
    return `{ <name>: ${extra} }`;
  }
  const pad = '  '.repeat(depth + 1);
  const lines = props.map(([key, sub]) => {
    const resolved = sub.$ref ? { ...deref(sub.$ref, root), ...sub } : sub;
    const note = first(resolved.description);
    return `${pad}${key}${required.has(key) ? '' : '?'}: ${render(sub, root, depth + 1)}${note ? `   // ${note}` : ''}`;
  });
  return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
}

/** The short form of one artifact: its name and purpose, the fields, the rules across them. */
export function shapeOf(artifact) {
  if (!ARTIFACTS.includes(artifact)) throw new Error(`not an artifact: ${artifact} (${ARTIFACTS.join(', ')}; implement, pr and release take a repo suffix when they are written)`);
  const schema = loadSchema(artifact);
  const out = [`${artifact} — ${first(schema.description)}`, `written: node state.mjs put <workdir> ${artifact} '<json>'   (schemaVersion is stamped; a field with ? may be left out)`, render(schema, schema)];
  if (RULES[artifact]) out.push(`rules: ${RULES[artifact].join('; ')}`);
  return out.join('\n');
}

/** Every artifact with its one-line purpose, for the command without an argument. */
export const catalogue = () => ARTIFACTS.map((a) => `${a.padEnd(11)} ${first(loadSchema(a).description)}`).join('\n');
