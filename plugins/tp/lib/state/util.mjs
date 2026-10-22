// util.mjs — the small pieces every state module shares: time stamps, safe reads and writes of the work directory's files, the text
// helpers, and CliError — what a command refuses with. A library function never prints or exits: it returns what the CLI should show, or
// throws a CliError that carries the message (stderr), the exit code and any stdout that goes with it; only state.mjs, the CLI shim,
// turns that into output and an exit. A hook that imports these functions catches the error instead of dying with it.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, resolve, isAbsolute } from 'node:path';

export function nowStamp() {
  return new Date().toISOString().slice(0, 16) + 'Z'; // YYYY-MM-DDTHH:MMZ (UTC)
}

export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// A path ticket.json recorded, as an absolute one. Every path a skill writes is already absolute
// (reference/definitions.md § Definitions, `<.claude>`); a record from an earlier pickup can hold a relative one, and
// resolving that against this script's cwd would report a worktree that is there as missing. The bases
// are the roots such a path was written against — the project folder around `<.claude>`, the `<.claude>`
// itself, the work directory (`wt/<repo>`) — first one that exists wins; nothing exists → the project
// folder's reading, so the caller reports a real absolute path.
export function recordedPath(p, workdir) {
  if (!p || isAbsolute(p)) return p;
  const claudeDir = resolve(workdir, '..', '..'); // <.claude>/work/<id> -> <.claude>
  const bases = [dirname(claudeDir), claudeDir, workdir];
  return bases.map((b) => resolve(b, p)).find(isDir) || resolve(bases[0], p);
}

export function readJson(path, problems) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    problems.push(`${basename(path)} is not valid JSON: ${e.message}`);
    return null;
  }
}

// A field never contains the separator or a line break; log() enforces it on write.
export function clean(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').replace(/ · /g, ' - ').trim();
}

// A question as one line, whatever shape a skill wrote it in: a string as it is; a structured question
// ({ text | question, choices | options: [...], default }) as "<text> — a | b? Default: a"; anything else stringified —
// never "[object Object]" (reference/work-directory.md § Work directory, triage.json).
export function questionText(q) {
  if (q == null) return '';
  if (typeof q === 'string') return q.trim();
  if (Array.isArray(q)) return q.map(questionText).filter(Boolean).join(' | ');
  if (typeof q === 'object') {
    const text = questionText(q.text ?? q.question ?? q.q ?? q.prompt ?? '');
    const choices = [q.choices, q.options, q.answers].find(Array.isArray);
    const dflt = q.default ?? q.defaultAnswer;
    let line = text;
    if (choices && choices.length) line += `${line ? ' — ' : ''}${choices.map((c) => (typeof c === 'string' ? c : c?.label ?? c?.text ?? JSON.stringify(c))).join(' | ')}?`;
    if (dflt != null && dflt !== '') line += ` Default: ${typeof dflt === 'string' ? dflt : JSON.stringify(dflt)}`;
    return (line || JSON.stringify(q)).trim();
  }
  return String(q);
}

// A count a skill may have written either as the number or as the list itself (plan.json's `steps` and
// `openQuestions` appear in both shapes): the list's length, a number as it is, '?' for anything else —
// never "[object Object]" in a question (reference/work-directory.md § Work directory, plan.json).
export function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return '?';
}

export function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What a command refuses with: the message for stderr, the exit code, and any stdout that belongs with it. */
export class CliError extends Error {
  constructor(message, code = 2, { stdout = '' } = {}) { super(message); this.name = 'CliError'; this.code = code; this.stdout = stdout; }
}
