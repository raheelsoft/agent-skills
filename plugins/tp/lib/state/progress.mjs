// progress.mjs — progress.md, the append-only log of a ticket: parsing a row, validating a stage name, appending one, and `log`, the one writer.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { modern } from '../setup.mjs';
import { EVENTS, EXTRA_STAGES, ORDER, PER_REPO, SEP } from './constants.mjs';
import { CliError, clean, isDir, nowStamp, readJson } from './util.mjs';
import { repoNames } from './stages.mjs';
import { touchLock } from './lock.mjs';

export function parseProgress(workdir, problems) {
  const file = join(workdir, 'progress.md');
  if (!existsSync(file)) { problems.push('progress.md missing'); return []; }
  const entries = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.startsWith('- ')) return; // headings and blank lines are ignored
    const f = line.slice(2).split(SEP);
    const [ts, stage, event] = f;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(ts || '') || !stage || !EVENTS.has(event)) {
      problems.push(`progress.md:${i + 1} does not match "- <UTC> · <stage> · <event> · <summary> · <links>"`);
      return;
    }
    entries.push({ i, ts, stage, event, summary: modern(f[3] || ''), links: f.slice(4).join(SEP) }); // an older install's `/tp-x` reads as `/tp:x`
  });
  return entries;
}

export function validStage(workdir, stage) {
  const [base, repo, extra] = stage.split(':');
  if (extra !== undefined) return `stage "${stage}" has more than one ":"`;
  if (!ORDER.includes(base) && !EXTRA_STAGES.has(base)) return `unknown stage "${base}" (expected ${[...ORDER, ...EXTRA_STAGES].join(', ')})`;
  const ticket = readJson(join(workdir, 'ticket.json'), []);
  const repos = repoNames(ticket, []);
  if (repo !== undefined && !PER_REPO.has(base)) return `stage "${base}" takes no repo suffix`;
  if (ticket && PER_REPO.has(base)) {
    if (repos.length > 1 && !repos.includes(repo)) return `stage "${stage}": this ticket's repos are ${repos.join(', ')} — use ${base}:<name>`;
    if (repos.length <= 1 && repo !== undefined) return `stage "${stage}": single-repo ticket, use plain "${base}"`;
  }
  return null;
}

export function log(workdir, stage, event, summary, links) {
  const usageLine = 'usage: log <workdir> <stage> <started|done|stopped|note> <summary> [links]';
  if (!isDir(workdir)) { throw new CliError(`${usageLine}\n${workdir} is not a directory`, 2); }
  if (!EVENTS.has(event) || !clean(stage) || (summary == null && event !== 'started')) { throw new CliError(usageLine, 2); }
  const bad = validStage(workdir, clean(stage));
  if (bad) { throw new CliError(bad, 2); }
  return appendLine(workdir, clean(stage), event, summary, links);
}

// append one grammar line (validated by the caller) and refresh a live lock
export function appendLine(workdir, stage, event, summary, links) {
  const parts = [nowStamp(), stage, event];
  if (clean(summary) || clean(links)) parts.push(clean(summary));
  if (clean(links)) parts.push(clean(links));
  const line = `- ${parts.join(SEP)}\n`;
  const file = join(workdir, 'progress.md');
  if (!existsSync(file)) writeFileSync(file, '# progress\n\n');
  appendFileSync(file, line);
  touchLock(workdir); // any progress is activity for the run lock
  return line;
}
