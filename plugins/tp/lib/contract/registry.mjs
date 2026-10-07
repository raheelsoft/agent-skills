// registry.mjs — which file in a work directory is which artifact, where its schema lives, and the checks that need the file system: one file,
// a whole work directory, a whole work root. The validator itself (schema.mjs) never touches the disk.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';
import { invariants } from './invariants.mjs';

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
/** Stamped into every artifact `put` writes; a later contract change bumps it and a reader can tell the generations apart. */
export const SCHEMA_VERSION = 1;
export const ARTIFACTS = ['ticket', 'triage', 'plan', 'plan-check', 'implement', 'pr', 'release', 'accept', 'retro'];

const cache = new Map();
/** A schema file by name — `ticket`, `ticket.schema.json` — parsed once. */
export function loadSchema(name) {
  const file = name.endsWith('.json') ? name : `${name}.schema.json`;
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
  return cache.get(file);
}

const SINGLE = /^(ticket|triage|plan|plan-check|accept|retro)\.json$/;
const PER_REPO = /^(implement|pr|release)(?:\.([A-Za-z0-9][\w.-]*))?\.json$/;
/** `{ artifact, repo }` for a work-directory file name, null for any other file (answers, logs, the jest output a stage saved…). */
export function artifactOf(fileName) {
  const name = basename(fileName);
  let m = SINGLE.exec(name);
  if (m) return { artifact: m[1], repo: null };
  m = PER_REPO.exec(name);
  return m ? { artifact: m[1], repo: m[2] || null } : null;
}

/** `{ ok, errors }` for one parsed artifact: the schema first, the cross-field invariants only when the shape is sound. */
export function checkArtifact(artifact, value, { mode = 'write' } = {}) {
  const errors = validate(loadSchema(artifact), value, { mode, load: loadSchema });
  if (!errors.length) errors.push(...invariants(artifact, value));
  return { ok: errors.length === 0, errors };
}

/** Every recognised artifact in one work directory: `{ dir, checked, invalid: [{ file, errors }] }` — a file that is not JSON is invalid too. */
export function checkWorkdir(dir, { mode = 'read' } = {}) {
  const invalid = [];
  let checked = 0;
  for (const file of readdirSync(dir).sort()) {
    const kind = artifactOf(file);
    if (!kind) continue;
    checked++;
    let value;
    try { value = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch (e) { invalid.push({ file, errors: [`$: not valid JSON — ${e.message}`] }); continue; }
    const r = checkArtifact(kind.artifact, value, { mode });
    if (!r.ok) invalid.push({ file, errors: r.errors });
  }
  return { dir, checked, invalid };
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** The same for a work root: one entry per ticket directory (`_`-prefixed ones are the pipeline's own and hold no artifacts). */
export function checkWorkroot(root, { mode = 'read' } = {}) {
  const dirs = readdirSync(root).filter((d) => !d.startsWith('_') && isDir(join(root, d))).sort();
  const tickets = dirs.map((d) => checkWorkdir(join(root, d), { mode }));
  return {
    checked: tickets.reduce((n, t) => n + t.checked, 0),
    invalid: tickets.flatMap((t) => t.invalid.map((i) => ({ file: `${basename(t.dir)}/${i.file}`, errors: i.errors }))),
  };
}
