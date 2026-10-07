// stages.mjs — which stages a ticket is expected to go through (the repos it names, planned or direct, minus the skills that are off) and where each
// one stands according to its progress rows.
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ORDER, PER_REPO } from './constants.mjs';
import { readJson } from './util.mjs';

export function repoNames(ticket, problems) {
  if (!ticket) return [];
  if (!Array.isArray(ticket.repos)) { problems.push('ticket.json: "repos" must be an array'); return []; }
  const names = ticket.repos.map((r, i) => {
    const n = r?.name || basename(r?.path || '');
    if (!n) problems.push(`ticket.json: repos[${i}] has neither name nor path`);
    return n;
  }).filter(Boolean);
  if (new Set(names).size !== names.length) problems.push('ticket.json: duplicate repo names');
  return names;
}

export function expectedStages(repos, planned, off = new Set()) {
  const groups = []; // [{ base, names: [...] }] — siblings of one base share a slot
  for (const s of ORDER) {
    if ((s === 'plan' || s === 'plan-check') && !planned) continue;
    if (off.has(s)) continue; // the skill is off for this project (<.claude>/pipeline.json, setup.mjs): the stage is not expected
    groups.push({ base: s, names: PER_REPO.has(s) && repos.length > 1 ? repos.map((r) => `${s}:${r}`) : [s] });
  }
  return groups;
}

export function stageStatus(entries, stage) {
  const own = entries.filter((e) => e.stage === stage);
  if (!own.length) return { status: 'pending' };
  // index of the stage's latest run (its last `started`/`done`): later stages older than this are stale
  const lastIdx = Math.max(...own.filter((e) => e.event === 'started' || e.event === 'done').map((e) => e.i), -1);
  const lastStop = [...own].reverse().find((e) => e.event === 'stopped');
  const resumedAfterStop = lastStop && own.some((e) => e.event === 'started' && e.i > lastStop.i);
  if (lastStop && !resumedAfterStop) return { status: 'stopped', at: lastStop.ts, question: lastStop.summary, idx: lastStop.i, lastIdx };
  const lastDone = [...own].reverse().find((e) => e.event === 'done');
  const startedAfterDone = lastDone && own.some((e) => e.event === 'started' && e.i > lastDone.i);
  if (lastDone && !startedAfterDone) return { status: 'done', at: lastDone.ts, idx: lastDone.i, summary: lastDone.summary, lastIdx };
  return { status: 'in-progress', at: own[own.length - 1].ts, idx: own[own.length - 1].i, lastIdx };
}

// retro.json -> { proposals, byTarget } or null when no retro ran
export function readRetro(workdir, problems) {
  if (!existsSync(join(workdir, 'retro.json'))) return null;
  const r = readJson(join(workdir, 'retro.json'), problems);
  const list = Array.isArray(r?.proposals) ? r.proposals : [];
  const byTarget = {};
  for (const p of list) byTarget[p?.target || 'unknown'] = (byTarget[p?.target || 'unknown'] || 0) + 1;
  return { proposals: list.length, byTarget };
}

// answers.md line `go-ahead: <timestamp> — round <n> — <flags>` at column 0, for this ticket's round
export function goAhead(answers, round) {
  return new RegExp(`^go-ahead:.*\\bround ${Number(round) || 1}\\b`, 'm').test(answers);
}

// ticket.json.blockedBy rows as recorded; triage.json's bare ids when the ticket has none yet
export function blockedByOf(ticket, triage) {
  const rows = Array.isArray(ticket?.blockedBy) ? ticket.blockedBy : Array.isArray(triage?.blockedBy) ? triage.blockedBy : [];
  return rows.map((b) => (typeof b === 'string' ? { id: b } : b)).filter((b) => b && typeof b.id === 'string' && b.id)
    .map((b) => ({ id: b.id, state: b.state ?? null, resolved: b.resolved === true, soft: b.soft === true, checkedAt: b.checkedAt ?? null }));
}
