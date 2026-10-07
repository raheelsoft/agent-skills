// put.mjs — the one writer of a work directory's JSON artifacts. The JSON is checked against the artifact's schema before anything touches the disk
// (schemas/README.md); a document that does not conform is refused with the errors, so the stage that wrote it fixes it while it still has the
// facts in hand, and the next stage never reads a malformed one. Stamps `schemaVersion`; writes atomically.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, isDir, writeAtomic } from './util.mjs';
import { ARTIFACTS, SCHEMA_VERSION, artifactOf, checkArtifact } from '../contract/index.mjs';

const usageLine = 'usage: put <workdir> <artifact> \'<json>\' | put <workdir> <artifact> --from <file> | … <<EOF (JSON on stdin) [--merge]';
const MAX_LINES = 15;

/** The JSON text a command was given: its argument, a file, or — with neither — standard input. */
export function payloadText({ arg, from } = {}) {
  if (from) {
    if (!existsSync(from)) throw new CliError(`${usageLine}\nno such file: ${from}`, 2);
    return readFileSync(from, 'utf8');
  }
  if (typeof arg === 'string' && arg !== '') return arg;
  try { return readFileSync(0, 'utf8'); } catch { throw new CliError(`${usageLine}\nno JSON given and nothing on stdin`, 2); }
}

/**
 * Validate `payload` (an object or its JSON text) as `name` — `triage`, `implement.<repo>`, `pr` … — and write it to the work directory.
 * `merge` lays the payload's top-level keys over the artifact already there (the stage that adds a field to a record it wrote before).
 * Returns `{ file, artifact }`; refuses with a CliError (exit 2) and writes nothing when the name is unknown or the JSON does not conform.
 */
export function putArtifact(workdir, name, payload, { merge = false } = {}) {
  if (!isDir(workdir)) throw new CliError(`${usageLine}\n${workdir} is not a work directory`, 2);
  if (basename(dirname(resolve(workdir))) !== 'work') throw new CliError(`${usageLine}\n${workdir} is not a ticket's work directory (<.claude>/work/<id>): the folder the ticket's other files are in`, 2);
  const file = `${String(name || '').replace(/\.json$/, '')}.json`;
  const kind = /^[\w.-]+$/.test(file) ? artifactOf(file) : null;
  if (!kind) throw new CliError(`${usageLine}\n"${name}" is not an artifact: ${ARTIFACTS.join(', ')} (implement, pr and release take a repo suffix: implement.<repo>)`, 2);

  let doc;
  try { doc = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { throw new CliError(`${usageLine}\nthe JSON does not parse: ${e.message}`, 2); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CliError(`${usageLine}\n${file} is a JSON object`, 2);

  const target = join(workdir, file);
  if (merge) {
    let existing;
    try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch { throw new CliError(`${usageLine}\n--merge needs ${file} to exist and be valid JSON; put it whole first`, 2); }
    doc = { ...existing, ...doc };
  }
  doc = { schemaVersion: SCHEMA_VERSION, ...doc };

  const r = checkArtifact(kind.artifact, doc, { mode: 'write' });
  if (!r.ok) {
    const shown = r.errors.slice(0, MAX_LINES).map((e) => `  ${e}`);
    if (r.errors.length > MAX_LINES) shown.push(`  … and ${r.errors.length - MAX_LINES} more`);
    throw new CliError(`refused ${file}: it does not match schemas/${kind.artifact}.schema.json\n${shown.join('\n')}\nnothing was written — correct the JSON and put it again`, 2);
  }
  writeAtomic(target, doc);
  return { file, artifact: kind.artifact };
}
