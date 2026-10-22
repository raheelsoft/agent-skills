// doc.mjs — the one writer of the work directory's documents (plan.md, report.md, the checkpoints …). The runtime refuses an agent's file tool,
// redirect or `mkdir` under `<.claude>/` when nobody is there to approve it, so an agent draws a document up where it may write
// (`<.claude>/worktrees/_out/`, or on stdin) and this script puts it in place — the way `put` does for the JSON, which it never takes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, isDir } from './util.mjs';

const usageLine = 'usage: doc <dir> <name> [--append] [--from <file>] (the text on stdin when there is no --from)';
const MAX_BYTES = 2_000_000;
// folders of the work root a stage writes into besides a ticket's own; _office and _inbox are the scripts' alone
const SCRATCH = new Set(['_scratch', '_day']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The text a command was given: a file, or — without one — standard input. */
export function docText({ from } = {}) {
  if (from) {
    if (!existsSync(from)) throw new CliError(`${usageLine}\nno such file: ${from}`, 2);
    return readFileSync(from, 'utf8');
  }
  try { return readFileSync(0, 'utf8'); } catch { throw new CliError(`${usageLine}\nno text given: nothing on stdin and no --from`, 2); }
}

/**
 * Write `text` to `<dir>/<name>` (replace it, or add to the end with `append`). `dir` is a ticket's work directory or the work root's `_scratch` or
 * `_day`; a ticket's directory is created by its first document, `ticket.md`. A ticket's JSON goes through `put` and `progress.md` through `log`;
 * `_scratch` and `_day` also take JSON (a stop record, a gathered input), which must parse. Returns `{ file, bytes, mode }`.
 */
export function writeDoc(dir, name, text, { append = false } = {}) {
  const where = resolve(String(dir || ''));
  if (basename(dirname(where)) !== 'work') throw new CliError(`${usageLine}\n${dir} is not a ticket's work directory, nor _scratch or _day (<.claude>/work/<id>)`, 2);
  const leaf = basename(where);
  const ticket = !leaf.startsWith('_');
  if (!ticket && !SCRATCH.has(leaf)) throw new CliError(`${usageLine}\n${leaf}/ is written by the state script alone`, 2);
  const file = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(name || '')) ? `${name}.md` : String(name || ''); // `ticket` is `ticket.md`: a name with no extension is a markdown document
  if (!NAME.test(file) || !/\.(md|txt|json)$/.test(file) || file.endsWith('.tmp')) throw new CliError(`${usageLine}\n"${name}" is not a document name: letters, digits, . _ - and ending .md, .txt or .json`, 2);
  if (file === 'progress.md') throw new CliError(`${usageLine}\nprogress.md is appended with \`state.mjs log\``, 2);
  if (ticket && file.endsWith('.json')) throw new CliError(`${usageLine}\na ticket's JSON goes through \`state.mjs put <workdir> <artifact>\`, which checks it against its schema`, 2);
  if (typeof text !== 'string' || !text.trim()) throw new CliError(`${usageLine}\nthe text is empty — nothing was written`, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new CliError(`${usageLine}\nthe text is over ${MAX_BYTES / 1_000_000} MB`, 2);
  if (file.endsWith('.json')) {
    if (append) throw new CliError(`${usageLine}\na JSON file is written whole, not appended to`, 2);
    try { JSON.parse(text); } catch (e) { throw new CliError(`${usageLine}\n${file} is not valid JSON: ${e.message}`, 2); }
  }
  if (!isDir(where)) {
    if (ticket && file !== 'ticket.md') throw new CliError(`${usageLine}\n${leaf}/ does not exist: a ticket's work directory begins with its ticket.md`, 2);
    mkdirSync(where, { recursive: true });
  }
  const target = join(where, file);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (append && existsSync(target)) {
    const before = readFileSync(target, 'utf8');
    appendFileSync(target, `${before === '' || before.endsWith('\n') ? '' : '\n'}${body}`);
  } else {
    writeFileSync(`${target}.tmp`, body);
    renameSync(`${target}.tmp`, target);
  }
  return { file: `${leaf}/${file}`, bytes: Buffer.byteLength(body), mode: append ? 'append' : 'write' };
}
