// inbox.mjs — every open stop of a work root, oldest first, and the queue of answers for them: answerQueue puts one in, answerTake takes it out for
// the invocation that resumes the ticket (README § Definitions, Asking the user, Resume).
import { existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { modern } from '../setup.mjs';
import { CliError, isDir, nowIso, readJson, writeAtomic } from './util.mjs';
import { classifyStop } from './classify.mjs';
import { all, computeState } from './compute.mjs';
import { inboxFile, pendingAnswer } from './answers.mjs';

// ticket-less stops: <workroot>/_scratch/<skill>-<slug>.stop.json, written by skills without a work directory
export function scratchStops(workroot) {
  const dir = join(workroot, '_scratch');
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.stop.json'))
    .map((f) => { const x = readJson(join(dir, f), []); return x && typeof x.id === 'string' && x.question ? { ...x, question: modern(x.question), resume: modern(x.resume), file: join(dir, f) } : null; })
    .filter(Boolean);
}

// the current stop an answer must name: a ticket's, or a scratch stop's
export function stopFor(workroot, id) {
  const wd = join(workroot, id);
  if (isDir(wd) && existsSync(join(wd, 'progress.md'))) {
    const st = computeState(wd);
    return st.stopped ? { ...st.stopped, ticket: st.id, link: st.link } : null;
  }
  const sc = scratchStops(workroot).find((x) => x.id === id);
  return sc ? { stage: sc.skill || sc.id.split(':')[0], question: sc.question, at: sc.at, kind: sc.kind || 'question', resume: sc.resume || null, doc: sc.doc || null, ticket: null } : null;
}

export function inbox(workroot, now = Date.now()) {
  const items = [];
  const minutes = (ts) => (ts ? Math.max(0, Math.round((now - Date.parse(ts)) / 60000)) : null);
  for (const r of all(workroot)) {
    if (r.status === 'error') { items.push({ id: r.id, ticket: r.id, stage: null, kind: 'problem', question: (r.problems || []).join('; '), since: null, waitingMin: null, default: 'retry', resume: `/tp:run-ticket ${r.id} answers=retry`, link: null, needs: (r.problems || []).join('; '), answer: null, lock: null }); continue; }
    if (r.stopped) {
      items.push({ id: r.id, ticket: r.id, stage: r.stopped.stage, kind: r.stopped.kind, question: r.stopped.question, doc: r.stopped.doc ?? null, since: r.stopped.at, waitingMin: minutes(r.stopped.at), default: r.stopped.default ?? null, resumable: r.stopped.resumable, resetAt: r.stopped.resetAt ?? null, needs: r.stopped.needs ?? null, resume: r.stopped.resume, link: r.link, blockedBy: r.blockedBy, problems: r.problems, answer: r.answer, lock: r.lock });
    } else if (r.problems && r.problems.length && r.status !== 'closed') {
      items.push({ id: r.id, ticket: r.id, stage: r.next, kind: 'problem', question: r.problems.join('; '), since: r.lastEvent?.ts || null, waitingMin: minutes(r.lastEvent?.ts), default: 'retry', resumable: false, needs: r.problems.join('; '), resume: `/tp:run-ticket ${r.id} answers=retry`, link: r.link, problems: r.problems, answer: null, lock: r.lock });
    }
  }
  for (const sc of scratchStops(workroot)) {
    const queued = pendingAnswer(workroot, sc.id);
    const st = classifyStop({ question: sc.question, at: sc.at }, { id: sc.id }, now);
    items.push({ id: sc.id, ticket: null, stage: sc.skill || sc.id.split(':')[0], kind: sc.kind || st.kind, question: sc.question, doc: sc.doc ?? null, since: sc.at || null, waitingMin: minutes(sc.at), default: sc.default ?? st.default, resumable: false, needs: sc.needs ?? null, resume: sc.resume || null, link: null, answer: queued && queued.at === sc.at ? { text: queued.answer, queuedAt: queued.queuedAt, by: queued.by } : null, lock: null });
  }
  return items.sort((a, b) => (Date.parse(a.since || 0) || 0) - (Date.parse(b.since || 0) || 0));
}

export function answerQueue(workroot, id, stage, text, by = 'cli') {
  const usageLine = 'usage: answer <workroot> <id> <stage> \'<text>\' [--by office|cli] | answer <workroot> <id> --consume|--peek';
  if (!isDir(workroot) || !id || !stage || typeof text !== 'string') { throw new CliError(usageLine, 2); }
  const stop = stopFor(workroot, id);
  if (!stop) { throw new CliError(`${id} is not stopped — nothing to answer`, 3); }
  if (stop.stage !== stage) { throw new CliError(`${id} is stopped at ${stop.stage}, not ${stage}`, 3); }
  const record = { id, stage, question: stop.question, at: stop.at, answer: text, queuedAt: nowIso(), by: by === 'office' ? 'office' : 'cli' };
  writeAtomic(inboxFile(workroot, id), record);
  return record;
}

// --consume: the queued answer for the ticket's *current* stop (exit 0, the file removed); none → exit 1; a queued
// answer for an earlier stop is set aside as <id>.stale.json → exit 3. --peek shows without touching.
export function answerTake(workroot, id, mode) {
  const a = pendingAnswer(workroot, id);
  if (!a) { throw new CliError(`no queued answer for ${id}`, 1); }
  const stop = stopFor(workroot, id);
  const matches = !!stop && stop.stage === a.stage && stop.at === a.at;
  if (mode === '--peek') return { ...a, stale: !matches, current: stop ? { stage: stop.stage, at: stop.at } : null };
  const file = inboxFile(workroot, id);
  if (!matches) {
    renameSync(file, file.replace(/\.json$/, '.stale.json'));
    throw new CliError('', 3, { stdout: JSON.stringify({ ...a, stale: true, current: stop ? { stage: stop.stage, at: stop.at } : null }, null, 2) + '\n' });
  }
  unlinkSync(file);
  return a;
}
