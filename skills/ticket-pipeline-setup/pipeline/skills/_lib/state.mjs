#!/usr/bin/env node
// Deterministic state for the ticket workflow (see skills/README.md).
//
//   node state.mjs log   <workdir> <stage> <started|done|stopped|note> <summary> [links]
//   node state.mjs state <workdir>            -> JSON: id, title, link, decision, complexity, estimate, stages, next, stopped, closed, prs, worktrees, lock, retro, lastEvent, problems
//   node state.mjs state <workdir> --brief    -> the decision fields only: id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems
//                                                (what an orchestrator routes on — a tenth of the size; the full form is for a stage's own steps)
//   node state.mjs check <workdir>            -> same as state; exit 1 when problems exist
//   node state.mjs all   <workroot>           -> JSON array, one entry per work directory
//   node state.mjs durations <workdir>        -> JSON: minutes per stage (started -> done/stopped)
//   node state.mjs usage <workdir> [--claude <.claude>] [--date YYYY-MM-DD]
//                                             -> JSON: { perStage, perTier, total, cost, unpriced, partial } from "tokens=<n> tier=<rating>"
//                                                in logged lines, priced by <.claude>/tiers.json `prices` ($ per 1M tokens, per tier)
//   node state.mjs totals <workroot> [--date YYYY-MM-DD] -> the same summed over every ticket, plus ticket counts
//   node state.mjs lock   <workdir> <owner>   -> take the run lock (exit 3 if another owner holds a live one)
//   node state.mjs unlock <workdir> <owner>   -> release it (`--force` releases anyone's)
//   node state.mjs inbox  <workroot>          -> JSON array: every open stop (tickets' stops, problems, ticket-less stops from
//                                                _scratch/*.stop.json), oldest first, each with its kind, resume command and any queued answer
//   node state.mjs answer <workroot> <id> <stage> '<text>' [--by office|cli]  -> queue an answer for that exact stop in _inbox/ (exit 3 when
//                                                the ticket is not stopped at that stage)
//   node state.mjs answer <workroot> <id> --consume|--peek  -> take (or show) the queued answer: exit 0 and the record when it matches the
//                                                current stop, 1 when there is none, 3 when it is stale (set aside as <id>.stale.json)
//   node state.mjs blockers <workdir> '<json>'  -> record the blockers' states in ticket.json (blockedBy rows), derive `unblocked`, note it
//   node state.mjs actual <workdir> '<json>'    -> record the person's actual hours in ticket.json ({ focusedHours, source, by })
//   node state.mjs agent join  <workroot> '<json>'          -> register an agent for the office (returns its record, with its name)
//   node state.mjs agent leave <workroot> <id> [done|stopped|gone]  -> mark it gone
//   node state.mjs office <workroot>          -> JSON: team, projects, tickets, agents, inbox, day, budget, doctor, totals — what the office draws
//
// Every stop the state reports carries `kind` (question | approval | error | usage | blocked | problem), `doc` (the file the
// person must read to answer, relative to the WORK ROOT — a plan, named, never inlined), `resumable`, `default`
// and `resume` — the command that continues the ticket (README § Definitions, Asking the user).
// No dependencies beyond the sibling scripts (day.mjs for the day board).

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, basename, dirname, resolve } from 'node:path';
import { status as dayStatus } from './day.mjs';
import { offStages } from './setup.mjs';

const EVENTS = new Set(['started', 'done', 'stopped', 'note']);
const ORDER = ['start-ticket', 'triage', 'plan', 'plan-check', 'implement', 'create-pr', 'merge', 'release', 'accept'];
const PER_REPO = new Set(['implement', 'create-pr', 'merge', 'release']);
const EXTRA_STAGES = new Set(['run-ticket', 'retro']); // logged, never part of the expected sequence
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // a lock nobody refreshed for 6 h belongs to a dead run
const SEP = ' · ';

function nowStamp() {
  return new Date().toISOString().slice(0, 16) + 'Z'; // YYYY-MM-DDTHH:MMZ (UTC)
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function readJson(path, problems) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    problems.push(`${basename(path)} is not valid JSON: ${e.message}`);
    return null;
  }
}

// A field never contains the separator or a line break; log() enforces it on write.
function clean(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').replace(/ · /g, ' - ').trim();
}

// A question as one line, whatever shape a skill wrote it in: a string as it is; a structured question
// ({ text | question, choices | options: [...], default }) as "<text> — a | b? Default: a"; anything else stringified —
// never "[object Object]" (README § Work directory, triage.json).
function questionText(q) {
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

function parseProgress(workdir, problems) {
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
    entries.push({ i, ts, stage, event, summary: f[3] || '', links: f.slice(4).join(SEP) });
  });
  return entries;
}

function repoNames(ticket, problems) {
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

function expectedStages(repos, planned, off = new Set()) {
  const groups = []; // [{ base, names: [...] }] — siblings of one base share a slot
  for (const s of ORDER) {
    if ((s === 'plan' || s === 'plan-check') && !planned) continue;
    if (off.has(s)) continue; // the skill is off for this project (<.claude>/pipeline.json, setup.mjs): the stage is not expected
    groups.push({ base: s, names: PER_REPO.has(s) && repos.length > 1 ? repos.map((r) => `${s}:${r}`) : [s] });
  }
  return groups;
}

function stageStatus(entries, stage) {
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

function readLock(workdir) {
  const lock = readJson(join(workdir, 'lock.json'), []);
  if (!lock?.owner) return null;
  const stale = Date.now() - Date.parse(lock.updated || lock.since || 0) > LOCK_STALE_MS;
  return { ...lock, stale };
}

// retro.json -> { proposals, byTarget } or null when no retro ran
function readRetro(workdir, problems) {
  if (!existsSync(join(workdir, 'retro.json'))) return null;
  const r = readJson(join(workdir, 'retro.json'), problems);
  const list = Array.isArray(r?.proposals) ? r.proposals : [];
  const byTarget = {};
  for (const p of list) byTarget[p?.target || 'unknown'] = (byTarget[p?.target || 'unknown'] || 0) + 1;
  return { proposals: list.length, byTarget };
}

function lockRun(workdir, owner) {
  if (!isDir(workdir) || !owner) { console.error('usage: lock <workdir> <owner>'); process.exit(2); }
  const cur = readLock(workdir);
  if (cur && cur.owner !== owner && !cur.stale) {
    console.error(`locked by ${cur.owner} since ${cur.since} (last activity ${cur.updated})`);
    process.exit(3);
  }
  const now = nowStamp();
  writeFileSync(join(workdir, 'lock.json'), JSON.stringify({ owner, since: cur?.owner === owner ? cur.since : now, updated: now }, null, 2) + '\n');
  process.stdout.write(`locked by ${owner}\n`);
}

function unlockRun(workdir, owner, force) {
  const file = join(workdir, 'lock.json');
  const cur = readLock(workdir);
  if (!cur) { process.stdout.write('no lock to release\n'); return; }
  if (cur.owner !== owner && !force && !cur.stale) { console.error(`locked by ${cur.owner}; pass --force to release it`); process.exit(3); }
  unlinkSync(file);
  process.stdout.write(`unlocked (${cur.owner})\n`);
}

// any progress refreshes a live lock; a stale one belongs to a dead run and is never revived by a note
function touchLock(workdir) {
  const cur = readLock(workdir);
  if (cur && !cur.stale) writeFileSync(join(workdir, 'lock.json'), JSON.stringify({ owner: cur.owner, since: cur.since, updated: nowStamp() }, null, 2) + '\n');
}

// answers.md line `go-ahead: <timestamp> — round <n> — <flags>` at column 0, for this ticket's round
function goAhead(answers, round) {
  return new RegExp(`^go-ahead:.*\\bround ${Number(round) || 1}\\b`, 'm').test(answers);
}

// ticket.json.blockedBy rows as recorded; triage.json's bare ids when the ticket has none yet
function blockedByOf(ticket, triage) {
  const rows = Array.isArray(ticket?.blockedBy) ? ticket.blockedBy : Array.isArray(triage?.blockedBy) ? triage.blockedBy : [];
  return rows.map((b) => (typeof b === 'string' ? { id: b } : b)).filter((b) => b && typeof b.id === 'string' && b.id)
    .map((b) => ({ id: b.id, state: b.state ?? null, resolved: b.resolved === true, soft: b.soft === true, checkedAt: b.checkedAt ?? null }));
}

const STOP_KINDS = ['question', 'approval', 'error', 'usage', 'blocked', 'problem'];

// the reset time a usage pause names ("resume after <ISO>" or "<HH:MM>[Z]"), resolved against the stop's own day
function resetTimeOf(question, at) {
  const m = /resume after ([^—|]+)/i.exec(question || '');
  if (!m) return null;
  const raw = m[1].trim().replace(/[.)\]]+$/, '');
  if (!Number.isNaN(Date.parse(raw))) return new Date(Date.parse(raw)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hm = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!hm || !/^\d{4}-\d{2}-\d{2}T/.test(at || '')) return null;
  let t = Date.parse(`${at.slice(0, 10)}T${hm[1].padStart(2, '0')}:${hm[2]}:00Z`);
  if (t < Date.parse(at)) t += 24 * 3600000; // a reset before the stop's time is tomorrow's
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The document a stop is about (README § Definitions, Asking the user). A one-line question is enough to decide
// "which API?", never enough to approve a plan: the stop names the file and the context that interviews shows it to
// the person before asking. Named, never inlined: the question itself stays one line, and that line is what goes to
// chat. The path is relative to the WORK ROOT, one base for every stop — a ticket's ("<id>/plan.md") and a scratch
// stop's ("_day/<date>.md") sit in the same inbox, and a reader that has one has the other.
function docOf(stopped, ctx) {
  const q = stopped.question || '';
  if (!/^(approval needed:|open questions in)/i.test(q)) return null;
  const f = `${String(stopped.stage || '').split(':')[0]}.md`;
  return ctx.workdir && existsSync(join(ctx.workdir, f)) ? join(basename(ctx.workdir), f) : null;
}

// every stop gets a kind, what continues it and whether it can continue by itself — from the stop's own wording
// (README § Definitions, Asking the user); never from re-reading progress.md
function classifyStop(stopped, ctx = {}, now = Date.now()) {
  const q = stopped.question || '';
  const id = ctx.id || '?';
  let kind = 'question'; let dflt = null; let resetAt = null; let resumable = false; let needs = null; let resume = null;
  if (/^error:/i.test(q)) {
    kind = 'error';
    const parts = q.split(/\s+—\s+/);
    const r = parts.find((p) => /^resume:/i.test(p));
    resume = r ? r.replace(/^resume:\s*/i, '').trim() : `/tp-run-ticket ${id} answers=retry`;
    needs = parts.slice(1).filter((p) => !/^resume:/i.test(p)).join(' — ') || null;
    dflt = 'retry';
  } else if (/^usage at/i.test(q)) {
    kind = 'usage';
    resetAt = resetTimeOf(q, stopped.at);
    resumable = resetAt ? Date.parse(resetAt) <= now : false;
    resume = `/tp-run-ticket ${id}`;
  } else if (ctx.triageBlocked || /nothing to answer/i.test(q)) {
    kind = 'blocked';
    resumable = !!ctx.unblocked;
    resume = `/tp-run-ticket ${id}`;
    needs = q.replace(/^.*nothing to answer\s*[—-]?\s*/i, '').trim() || null;
  } else if (/^approval needed:/i.test(q)) {
    kind = 'approval';
    dflt = 'go-ahead';
    resume = `/tp-run-ticket ${id} answers=go-ahead`;
  } else {
    const items = q.split(/ \| (?=\d+[.:)]\s)/); // numbered questions are joined with " | "; a choice list inside one question is too
    const defaults = items.map((it) => { const m = /Default:\s*(.+?)\s*$/.exec(it); return m ? m[1].replace(/[.]$/, '') : null; });
    if (/^hand-off budget spent/i.test(q)) dflt = 'continue';
    else if (items.length === 1) dflt = defaults[0];
    else if (defaults.some(Boolean)) dflt = defaults.map((d, i) => `${i + 1}: ${d ?? ''}`).join(' | ');
    resume = `/tp-run-ticket ${id} answers="${dflt ?? '…'}"`;
  }
  Object.assign(stopped, { kind, default: dflt, resetAt, resumable, needs, resume, doc: stopped.doc ?? docOf(stopped, ctx) });
  return stopped;
}

function computeState(workdir) {
  const problems = [];
  if (!isDir(workdir)) return { id: basename(workdir), stages: [], next: null, stopped: null, prs: [], lastEvent: null, problems: [`${workdir} is not a directory`] };
  const entries = parseProgress(workdir, problems);
  const ticket = readJson(join(workdir, 'ticket.json'), problems);
  const triage = readJson(join(workdir, 'triage.json'), problems);
  const plan = readJson(join(workdir, 'plan.json'), problems);
  const check = readJson(join(workdir, 'plan-check.json'), problems);
  const repos = repoNames(ticket, problems);
  const planned = triage?.decision === 'plan';
  const off = new Set(offStages(dirname(dirname(resolve(workdir))))); // stages whose skills the project turned off
  const groups = expectedStages(repos, planned, off);
  const expectedNames = new Set(groups.flatMap((g) => g.names));

  for (const e of entries) {
    if (expectedNames.has(e.stage) || EXTRA_STAGES.has(e.stage)) continue;
    const base = e.stage.split(':')[0];
    if (off.has(base)) continue; // logged while the skill was on: kept, never a problem
    if (!ORDER.includes(base)) problems.push(`progress.md:${e.i + 1} unknown stage "${e.stage}"`);
    else if (base !== 'plan' && base !== 'plan-check') {
      const expected = [...expectedNames].filter((n) => n.split(':')[0] === base).join(', ') || 'none';
      problems.push(`progress.md:${e.i + 1} stage "${e.stage}" does not match this ticket's repos (expected ${expected})`);
    }
  }

  const out = [];
  // latest run (started/done) index among earlier slots: shared stages count for everyone, a per-repo
  // stage only for its own repo — repo B's fix round never supersedes repo A's finished merge
  let sharedLast = -1;
  const repoLast = {};
  let next = null;
  let stopped = null;
  for (const g of groups) {
    const perRepoSlot = PER_REPO.has(g.base) && repos.length > 1;
    let slotMax = -1;
    const slotRepoMax = {};
    for (const s of g.names) {
      const repo = perRepoSlot ? s.split(':')[1] : null;
      const earlierLast = perRepoSlot
        ? Math.max(sharedLast, repoLast[repo] ?? -1)
        : Math.max(sharedLast, ...Object.values(repoLast), -1);
      const st = stageStatus(entries, s);
      // an earlier stage ran again after this stage finished or stopped: this outcome is superseded
      if ((st.status === 'done' || st.status === 'stopped') && st.idx < earlierLast) st.status = 'stale';
      if (st.status !== 'pending' && st.status !== 'stale') {
        slotMax = Math.max(slotMax, st.lastIdx);
        if (repo) slotRepoMax[repo] = Math.max(slotRepoMax[repo] ?? -1, st.lastIdx);
      }
      if (!next && st.status !== 'done') next = s;
      if (st.status === 'stopped' && !stopped) stopped = { stage: s, question: st.question, at: st.at };
      delete st.idx; delete st.lastIdx;
      out.push({ name: s, ...st });
    }
    // siblings in one slot never make each other stale
    if (perRepoSlot) for (const [r, v] of Object.entries(slotRepoMax)) repoLast[r] = Math.max(repoLast[r] ?? -1, v);
    else sharedLast = Math.max(sharedLast, slotMax);
  }

  // a triage that ended in needs-input is waiting on the user, whatever the log says
  if (triage?.decision === 'needs-input') {
    const t = out.find((s) => s.name === 'triage');
    if (t && t.status === 'done') {
      t.status = 'stopped';
      t.question = (Array.isArray(triage.questions) ? triage.questions : [triage.questions]).map((q, i) => { const s = questionText(q); return s ? (Array.isArray(triage.questions) && triage.questions.length > 1 && !/^\d+[.:)]/.test(s) ? `${i + 1}. ${s}` : s) : ''; }).filter(Boolean).join(' | ') || 'needs-input';
      next = 'triage';
      stopped = { stage: 'triage', question: t.question, at: t.at };
    }
  }
  // the blockers, as last recorded (ticket.json.blockedBy rows; triage's bare ids when nothing was recorded yet)
  const blockedBy = blockedByOf(ticket, triage);
  const unblocked = blockedBy.length > 0 && blockedBy.every((b) => b.resolved || b.soft);
  // a triage that parked the ticket (decision `blocked`) is a nothing-to-answer stop until its blockers are resolved
  if (triage?.decision === 'blocked') {
    const t = out.find((s) => s.name === 'triage');
    if (t && t.status === 'done') {
      t.status = 'stopped';
      t.question = `blocked by ${blockedBy.map((b) => b.id).join(', ') || '?'} — nothing to answer — resumes when they are resolved`;
      next = 'triage';
      stopped = { stage: 'triage', question: t.question, at: t.at };
    }
  }

  // required artefacts per completed stage
  const req = { 'start-ticket': ['ticket.md', 'ticket.json'], triage: ['triage.md', 'triage.json'], plan: ['plan.md', 'plan.json'], 'plan-check': ['plan-check.json'], accept: ['accept.md', 'accept.json'] };
  const perRepo = { implement: 'implement', 'create-pr': 'pr', merge: 'pr', release: 'release' };
  for (const s of out) {
    if (s.status !== 'done') continue;
    const [base, repo] = s.name.split(':');
    const prFile = repo ? `pr.${repo}.json` : 'pr.json';
    const files = req[base] || [repo ? `${perRepo[base]}.${repo}.json` : `${perRepo[base]}.json`, ...(base === 'create-pr' ? ['report.md'] : [])];
    for (const f of files) if (!existsSync(join(workdir, f))) problems.push(`${s.name} is done but ${f} is missing`);
    // a merge is done only with a merge sha in the PR record
    if (base === 'merge' && existsSync(join(workdir, prFile)) && !readJson(join(workdir, prFile), [])?.merged) problems.push(`${s.name} is done but ${prFile} has no merged sha`);
  }
  // waiting states of the plan stages are "stopped", not inconsistencies
  const planStage = out.find((s) => s.name === 'plan');
  const wait = (stage, question) => {
    if (!stage || stage.status !== 'done') return;
    stage.status = 'stopped'; stage.question = question;
    if (!stopped || ORDER.indexOf(stopped.stage.split(':')[0]) > ORDER.indexOf(stage.name)) stopped = { stage: stage.name, question, at: stage.at };
    next = stage.name;
  };
  if (planned && plan) {
    const answers = existsSync(join(workdir, 'answers.md')) ? readFileSync(join(workdir, 'answers.md'), 'utf8') : '';
    // every plan waits for the person's approval (README § Using it, When it stops) — a check still saying `revise`
    // presents its open findings as the risks the person may accept
    const blocking = (check?.findings || []).filter((f) => f.severity === 'blocking').length;
    const flags = Array.isArray(plan.flags) && plan.flags.length ? plan.flags.map(questionText).join(', ') : 'none';
    if (plan.status === 'open-questions') wait(planStage, `open questions in plan.md (${plan.openQuestions ?? '?'})`);
    else if (check && !goAhead(answers, ticket?.round)) {
      if (check.verdict === 'revise' && !check.override) wait(planStage, `approval needed: ${plan.steps ?? '?'} steps, risks: ${flags} — the check still has ${blocking} blocking finding(s); approve as is (go-ahead) or send a change`);
      else wait(planStage, `approval needed: ${plan.steps ?? '?'} steps, risks: ${flags} — approve (go-ahead) or send a change`);
    } else if (plan.status !== 'ready') problems.push(`plan.json status is "${plan.status}"`);
  } else if (plan && plan.status && plan.status !== 'ready') {
    problems.push(`plan.json status is "${plan.status}" (direct work writes a ready plan)`);
  }
  // a paused run (`run-ticket stopped`, e.g. a usage-limit pause) is the ticket's stop until the next `run-ticket started`
  if (!stopped) {
    const run = stageStatus(entries, 'run-ticket');
    if (run.status === 'stopped') stopped = { stage: 'run-ticket', question: run.question, at: run.at };
  }
  // closed early: triage decided `close` (delivered already, superseded, won't do), or the orchestrator ended the run
  // (`run-ticket done`) with stages still pending — the ticket counts as done until a later stage run opens a new round
  let closed = null;
  const triageStage = out.find((s) => s.name === 'triage');
  if (triage?.decision === 'close' && triageStage?.status === 'done') closed = { at: triageStage.at, why: questionText(triage.why) || triageStage.summary || 'closed by triage' };
  const runDone = [...entries].reverse().find((e) => e.stage === 'run-ticket' && e.event === 'done');
  if (!closed && runDone && next && !entries.some((e) => e.i > runDone.i && !EXTRA_STAGES.has(e.stage) && (e.event === 'started' || e.event === 'done'))) {
    closed = { at: runDone.ts, why: runDone.summary || 'the run ended early' };
  }
  if (closed) { next = null; stopped = null; }
  // a parked ticket recorded before blockedBy existed: the ids named in its stop are the blockers to re-check
  if (stopped && !blockedBy.length && /nothing to answer/i.test(stopped.question || '')) {
    const m = /blocked by ((?:[\w.-]+)(?:,\s*[\w.-]+)*)/i.exec(stopped.question);
    if (m) blockedBy.push(...m[1].split(/,\s*/).map((id) => ({ id, state: null, resolved: false, soft: false, checkedAt: null })));
  }
  if (stopped) {
    const m = /^step (\d+)\b/.exec(stopped.question || '');
    if (m) stopped.step = Number(m[1]);
    classifyStop(stopped, { id: ticket?.id || basename(workdir), unblocked, triageBlocked: triage?.decision === 'blocked', workdir });
  }

  // worktrees: expected from ticket.json while the ticket is open; present on disk under wt/
  const wt = join(workdir, 'wt');
  const worktreesOnDisk = isDir(wt) ? readdirSync(wt).filter((w) => isDir(join(wt, w))) : [];
  const started = out.some((s) => s.name === 'start-ticket' && s.status === 'done');
  if (ticket && Array.isArray(ticket.repos) && started) {
    for (const r of ticket.repos) {
      if (!r?.worktree || !r?.branch) continue;
      const name = r.name || basename(r.path || '');
      // the worktree lives from pickup to the end of the run (README § Worktrees); it must be on the ticket's branch
      // until this repo's PR is merged — afterwards accept may detach it at the merge commit, so nothing is checked
      const mergeStage = repos.length > 1 ? `merge:${name}` : 'merge';
      if (out.some((s) => s.name === mergeStage && s.status === 'done')) continue;
      if (!isDir(r.worktree)) { problems.push(`worktree for ${name} missing: ${r.worktree}`); continue; }
      try {
        const head = execFileSync('git', ['-C', r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
        if (head !== r.branch) problems.push(`worktree for ${name} is on "${head}", ticket.json says "${r.branch}"`);
      } catch (e) { problems.push(`worktree for ${name} is not a git checkout: ${r.worktree}`); }
    }
  }

  const prFiles = repos.length > 1 ? repos.map((r) => `pr.${r}.json`) : ['pr.json'];
  const prs = prFiles.map((f) => readJson(join(workdir, f), problems)).filter(Boolean);
  return {
    id: ticket?.id || basename(workdir),
    title: ticket?.title || null,
    link: ticket?.link || null,
    decision: triage?.decision || null,
    // the ticket's current complexity rating: the plan's, else triage's, else the pickup's (skills/README.md § Models)
    complexity: plan?.complexity || triage?.complexity || ticket?.complexity || null,
    // the person's hours (README § Models and budget, Estimates): triage's refinement, else the pickup's
    estimate: triage?.estimate || ticket?.estimate || null,
    // the person's actual hours, when /tp-eod recorded them (README § Models and budget, Estimates)
    actual: ticket?.actual && Number(ticket.actual.focusedHours) > 0 ? ticket.actual : null,
    blockedBy,
    unblocked,
    stages: out,
    next,
    stopped,
    closed,
    prs,
    worktrees: worktreesOnDisk,
    lock: readLock(workdir),
    retro: readRetro(workdir, problems),
    lastEvent: entries[entries.length - 1] || null,
    problems,
  };
}

function durations(workdir) {
  const entries = isDir(workdir) ? parseProgress(workdir, []) : [];
  const starts = {};
  const mins = {};
  for (const e of entries) {
    if (e.event === 'started') { if (!(e.stage in starts)) starts[e.stage] = e.ts; continue; } // a repeated start keeps the first
    if ((e.event === 'done' || e.event === 'stopped') && starts[e.stage]) {
      mins[e.stage] = (mins[e.stage] || 0) + Math.round((Date.parse(e.ts) - Date.parse(starts[e.stage])) / 60000);
      delete starts[e.stage];
    }
  }
  return mins;
}

// <.claude>/tiers.json `prices` — $ per 1M tokens per tier — for the work root's .claude directory
function pricesOf(claudeDir) {
  const t = claudeDir ? readJson(join(claudeDir, 'tiers.json'), []) : null;
  const p = t?.prices && typeof t.prices === 'object' ? t.prices : null;
  if (!p) return null;
  const out = {};
  for (const r of RATING_VALUES) if (Number(p[r]) >= 0) out[r] = Number(p[r]);
  return Object.keys(out).length ? out : null;
}

// tokens an agent reported, recorded as "tokens=<n> tier=<rating>" anywhere in a line's summary or links; priced when
// tiers.json names prices (README § Models and budget). `claudeDir` defaults to the parent of the work root; `date`
// keeps the lines of one day. `partial` when a run said its totals are incomplete ("tokens partial").
function usage(workdir, opts = {}) {
  const entries = isDir(workdir) ? parseProgress(workdir, []) : [];
  const prices = pricesOf(opts.claudeDir || dirname(dirname(resolve(workdir))));
  const perStage = {}; const perTier = {};
  let total = 0; let unpriced = 0; let cost = 0; let partial = false;
  for (const e of entries) {
    if (opts.date && !e.ts.startsWith(opts.date)) continue;
    const text = `${e.summary} ${e.links}`;
    if (/\btokens partial\b/.test(text)) partial = true;
    const m = /\btokens=(\d+)\b(?:\s+tier=(low|medium|high)\b)?/.exec(text);
    if (!m) continue;
    const n = Number(m[1]); const tier = m[2] || null;
    perStage[e.stage] = (perStage[e.stage] || 0) + n;
    perTier[tier || 'untiered'] = (perTier[tier || 'untiered'] || 0) + n;
    total += n;
    if (prices && tier && tier in prices) cost += n * prices[tier] / 1e6; else unpriced += n;
  }
  return { perStage, perTier, total, cost: prices ? Math.round(cost * 100) / 100 : null, unpriced, partial };
}

// the same over every ticket of a work root, plus how many tickets stand where
function totals(workroot, opts = {}) {
  const claudeDir = opts.claudeDir || dirname(resolve(workroot));
  const sum = { tokens: 0, cost: null, unpriced: 0, partial: false };
  const tickets = { active: 0, stopped: 0, done: 0, closed: 0 };
  for (const d of ticketDirs(workroot)) {
    const u = usage(d, { claudeDir, date: opts.date });
    sum.tokens += u.total; sum.unpriced += u.unpriced; sum.partial = sum.partial || u.partial;
    if (u.cost != null) sum.cost = Math.round(((sum.cost || 0) + u.cost) * 100) / 100;
    if (!opts.date) { const r = rowOf(d); if (r.status === 'done') tickets.done++; else if (r.status === 'closed') tickets.closed++; else if (r.status === 'stopped') tickets.stopped++; else tickets.active++; }
  }
  return opts.date ? sum : { ...sum, tickets };
}

function validStage(workdir, stage) {
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

function log(workdir, stage, event, summary, links) {
  const usage = 'usage: log <workdir> <stage> <started|done|stopped|note> <summary> [links]';
  if (!isDir(workdir)) { console.error(`${usage}\n${workdir} is not a directory`); process.exit(2); }
  if (!EVENTS.has(event) || !clean(stage) || (summary == null && event !== 'started')) { console.error(usage); process.exit(2); }
  const bad = validStage(workdir, clean(stage));
  if (bad) { console.error(bad); process.exit(2); }
  process.stdout.write(appendLine(workdir, clean(stage), event, summary, links));
}

// append one grammar line (validated by the caller) and refresh a live lock
function appendLine(workdir, stage, event, summary, links) {
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

// one ticket's row, as `all` and `office` list it
function rowOf(d) {
  try {
    const s = computeState(d);
    const ageMin = s.lastEvent ? Math.round((Date.now() - Date.parse(s.lastEvent.ts)) / 60000) : null;
    const mins = durations(d);
    const u = usage(d);
    const queued = pendingAnswer(dirname(d), s.id);
    return {
      id: s.id, title: s.title, link: s.link, decision: s.decision, complexity: s.complexity, estimate: s.estimate, actual: s.actual, next: s.next,
      status: s.closed ? 'closed' : s.stopped ? 'stopped' : s.next ? 'in-progress' : 'done',
      stopped: s.stopped, closed: s.closed, lastEvent: s.lastEvent, ageMin,
      stages: s.stages.map((st) => ({ name: st.name, status: st.status, at: st.at ?? null, minutes: mins[st.name] ?? null })),
      blockedBy: s.blockedBy, unblocked: s.unblocked,
      repos: repoNames(readJson(join(d, 'ticket.json'), []), []),
      prs: s.prs.map((p) => ({ url: p.url, verdict: p.verdict, reviewRounds: p.reviewRounds ?? null, merged: p.merged })),
      worktrees: s.worktrees,
      lock: s.lock ? { owner: s.lock.owner, since: s.lock.since, stale: s.lock.stale } : null,
      retro: s.retro,
      problems: s.problems,
      durations: mins,
      tokens: u.total, cost: u.cost, tokensUnpriced: u.unpriced, tokensPartial: u.partial,
      // an answer queued for the current stop (office or `state.mjs answer`), taken by the next invocation (README § Definitions, Resume)
      answer: queued && s.stopped && queued.stage === s.stopped.stage && queued.at === s.stopped.at ? { text: queued.answer, queuedAt: queued.queuedAt, by: queued.by } : null,
    };
  } catch (e) {
    return { id: basename(d), status: 'error', problems: [String(e.message)] };
  }
}

// the ticket directories under a work root: never the `_`-prefixed ones (_office, _scratch)
function ticketDirs(workroot) {
  if (!isDir(workroot)) return [];
  return readdirSync(workroot)
    .filter((n) => !n.startsWith('_'))
    .map((d) => join(workroot, d))
    .filter((d) => isDir(d) && existsSync(join(d, 'progress.md')));
}

function all(workroot) {
  return ticketDirs(workroot).map(rowOf);
}

// ---- the inbox: every open stop, and answers queued for them (README § Definitions, Asking the user) ----------------

const inboxDir = (workroot) => join(workroot, '_inbox');
const safeName = (id) => `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}`;
const inboxFile = (workroot, id) => join(inboxDir(workroot), `${safeName(id)}.json`);

function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

// the answer queued for `id`, or null
function pendingAnswer(workroot, id) {
  const f = inboxFile(workroot, id);
  const a = existsSync(f) ? readJson(f, []) : null;
  return a && a.id === id && typeof a.answer === 'string' ? a : null;
}

// ticket-less stops: <workroot>/_scratch/<skill>-<slug>.stop.json, written by skills without a work directory
function scratchStops(workroot) {
  const dir = join(workroot, '_scratch');
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.stop.json'))
    .map((f) => { const x = readJson(join(dir, f), []); return x && typeof x.id === 'string' && x.question ? { ...x, file: join(dir, f) } : null; })
    .filter(Boolean);
}

// the current stop an answer must name: a ticket's, or a scratch stop's
function stopFor(workroot, id) {
  const wd = join(workroot, id);
  if (isDir(wd) && existsSync(join(wd, 'progress.md'))) {
    const st = computeState(wd);
    return st.stopped ? { ...st.stopped, ticket: st.id, link: st.link } : null;
  }
  const sc = scratchStops(workroot).find((x) => x.id === id);
  return sc ? { stage: sc.skill || sc.id.split(':')[0], question: sc.question, at: sc.at, kind: sc.kind || 'question', resume: sc.resume || null, doc: sc.doc || null, ticket: null } : null;
}

function inbox(workroot, now = Date.now()) {
  const items = [];
  const minutes = (ts) => (ts ? Math.max(0, Math.round((now - Date.parse(ts)) / 60000)) : null);
  for (const r of all(workroot)) {
    if (r.status === 'error') { items.push({ id: r.id, ticket: r.id, stage: null, kind: 'problem', question: (r.problems || []).join('; '), since: null, waitingMin: null, default: 'retry', resume: `/tp-run-ticket ${r.id} answers=retry`, link: null, needs: (r.problems || []).join('; '), answer: null, lock: null }); continue; }
    if (r.stopped) {
      items.push({ id: r.id, ticket: r.id, stage: r.stopped.stage, kind: r.stopped.kind, question: r.stopped.question, doc: r.stopped.doc ?? null, since: r.stopped.at, waitingMin: minutes(r.stopped.at), default: r.stopped.default ?? null, resumable: r.stopped.resumable, resetAt: r.stopped.resetAt ?? null, needs: r.stopped.needs ?? null, resume: r.stopped.resume, link: r.link, blockedBy: r.blockedBy, problems: r.problems, answer: r.answer, lock: r.lock });
    } else if (r.problems && r.problems.length && r.status !== 'closed') {
      items.push({ id: r.id, ticket: r.id, stage: r.next, kind: 'problem', question: r.problems.join('; '), since: r.lastEvent?.ts || null, waitingMin: minutes(r.lastEvent?.ts), default: 'retry', resumable: false, needs: r.problems.join('; '), resume: `/tp-run-ticket ${r.id} answers=retry`, link: r.link, problems: r.problems, answer: null, lock: r.lock });
    }
  }
  for (const sc of scratchStops(workroot)) {
    const queued = pendingAnswer(workroot, sc.id);
    const st = classifyStop({ question: sc.question, at: sc.at }, { id: sc.id }, now);
    items.push({ id: sc.id, ticket: null, stage: sc.skill || sc.id.split(':')[0], kind: sc.kind || st.kind, question: sc.question, doc: sc.doc ?? null, since: sc.at || null, waitingMin: minutes(sc.at), default: sc.default ?? st.default, resumable: false, needs: sc.needs ?? null, resume: sc.resume || null, link: null, answer: queued && queued.at === sc.at ? { text: queued.answer, queuedAt: queued.queuedAt, by: queued.by } : null, lock: null });
  }
  return items.sort((a, b) => (Date.parse(a.since || 0) || 0) - (Date.parse(b.since || 0) || 0));
}

function answerQueue(workroot, id, stage, text, by = 'cli') {
  const usageLine = 'usage: answer <workroot> <id> <stage> \'<text>\' [--by office|cli] | answer <workroot> <id> --consume|--peek';
  if (!isDir(workroot) || !id || !stage || typeof text !== 'string') { console.error(usageLine); process.exit(2); }
  const stop = stopFor(workroot, id);
  if (!stop) { console.error(`${id} is not stopped — nothing to answer`); process.exit(3); }
  if (stop.stage !== stage) { console.error(`${id} is stopped at ${stop.stage}, not ${stage}`); process.exit(3); }
  const record = { id, stage, question: stop.question, at: stop.at, answer: text, queuedAt: nowIso(), by: by === 'office' ? 'office' : 'cli' };
  writeAtomic(inboxFile(workroot, id), record);
  return record;
}

// --consume: the queued answer for the ticket's *current* stop (exit 0, the file removed); none → exit 1; a queued
// answer for an earlier stop is set aside as <id>.stale.json → exit 3. --peek shows without touching.
function answerTake(workroot, id, mode) {
  const a = pendingAnswer(workroot, id);
  if (!a) { console.error(`no queued answer for ${id}`); process.exit(1); }
  const stop = stopFor(workroot, id);
  const matches = !!stop && stop.stage === a.stage && stop.at === a.at;
  if (mode === '--peek') return { ...a, stale: !matches, current: stop ? { stage: stop.stage, at: stop.at } : null };
  const file = inboxFile(workroot, id);
  if (!matches) {
    renameSync(file, file.replace(/\.json$/, '.stale.json'));
    process.stdout.write(JSON.stringify({ ...a, stale: true, current: stop ? { stage: stop.stage, at: stop.at } : null }, null, 2) + '\n');
    process.exit(3);
  }
  unlinkSync(file);
  return a;
}

// record the blockers' states (tp-start-ticket/instructions/blocked-check.md § Re-check) in ticket.json and note it
function recordBlockers(workdir, payload) {
  const usageLine = 'usage: blockers <workdir> \'[{ "id", "state", "resolved", "soft" }]\'';
  if (!isDir(workdir)) { console.error(usageLine); process.exit(2); }
  let rows;
  try { rows = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { console.error(`${usageLine}\n${e.message}`); process.exit(2); }
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string' || !r.id)) { console.error(`${usageLine}\nevery row needs an id`); process.exit(2); }
  const file = join(workdir, 'ticket.json');
  const ticket = readJson(file, []);
  if (!ticket) { console.error(`${file} missing or invalid`); process.exit(2); }
  const now = nowIso();
  ticket.blockedBy = rows.map((r) => ({ id: r.id, state: r.state ?? null, resolved: r.resolved === true, soft: r.soft === true, checkedAt: r.checkedAt || now }));
  writeAtomic(file, ticket);
  const unblocked = ticket.blockedBy.length > 0 && ticket.blockedBy.every((b) => b.resolved || b.soft);
  const st = computeState(workdir);
  if (st.stopped) {
    const summary = `blockers re-checked: ${ticket.blockedBy.map((b) => `${b.id} ${b.state || '?'}${b.resolved ? ' (resolved)' : b.soft ? ' (soft)' : ''}`).join(', ')}${unblocked ? ' — unblocked' : ''}`;
    appendLine(workdir, st.stopped.stage, 'note', summary, '');
  }
  return { blockedBy: ticket.blockedBy, unblocked };
}

// record the person's actual hours (README § Models and budget, Estimates) — the one writer of ticket.json.actual
function recordActual(workdir, payload) {
  const usageLine = 'usage: actual <workdir> \'{ "focusedHours": n, "source": "person|tracker", "by": "eod" }\'';
  if (!isDir(workdir)) { console.error(usageLine); process.exit(2); }
  let p;
  try { p = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { console.error(`${usageLine}\n${e.message}`); process.exit(2); }
  if (!p || !(Number(p.focusedHours) > 0)) { console.error(`${usageLine}\nfocusedHours must be a positive number`); process.exit(2); }
  const file = join(workdir, 'ticket.json');
  const ticket = readJson(file, []);
  if (!ticket) { console.error(`${file} missing or invalid`); process.exit(2); }
  ticket.actual = { focusedHours: Math.round(Number(p.focusedHours) * 2) / 2, source: p.source === 'tracker' ? 'tracker' : 'person', at: nowIso(), by: typeof p.by === 'string' && p.by ? p.by : 'eod' };
  writeAtomic(file, ticket);
  return ticket.actual;
}

// ---- the office: who is at work, for skills/README.md § Observability -------------------------

const LEVELS = ['manager', 'lead', 'engineer', 'qa', 'reviewer'];
const POOLS = { manager: 'managers', lead: 'leads', engineer: 'engineers', qa: 'qa', reviewer: 'reviewers' };
const DEFAULT_NAMES = { // neutral pools; office.json overrides them
  managers: ['Morgan', 'Avery', 'Jordan', 'Riley'],
  leads: ['Sam', 'Casey', 'Quinn', 'Harper', 'Rowan', 'Reese', 'Emerson', 'Blake'],
  engineers: ['Alex', 'Jamie', 'Taylor', 'Drew', 'Kai', 'Noor', 'Remy', 'Sage', 'Ari', 'Lee', 'Nico', 'Sky'],
  qa: ['Robin', 'Devon', 'Shay', 'Finley', 'Marlow', 'Indigo'],
  reviewers: ['Dana', 'Eden', 'Parker', 'Jules'],
};
const AGENT_LEFT_KEEP_MS = 60 * 60 * 1000;       // a departed agent's record lives an hour
const AGENT_STALE_MS = 24 * 60 * 60 * 1000;      // an agent nobody refreshed for a day is forgotten

function officeConfig(workroot) {
  const file = join(dirname(resolve(workroot)), 'office.json'); // <.claude>/office.json next to work/
  const cfg = readJson(file, []) || {};
  const names = { ...DEFAULT_NAMES };
  for (const [k, v] of Object.entries(cfg.names || {})) if (Array.isArray(v) && v.length) names[k] = v.map(String);
  return {
    team: typeof cfg.team === 'string' && cfg.team ? cfg.team : basename(dirname(resolve(workroot))),
    projects: Array.isArray(cfg.projects) ? cfg.projects.map(String) : [],
    poll: Number(cfg.poll) > 0 ? Number(cfg.poll) : 2500,
    linger: Number(cfg.linger) >= 0 ? Number(cfg.linger) : 120,
    names,
  };
}

const agentsDir = (workroot) => join(workroot, '_office', 'agents');
const agentFile = (workroot, id) => join(agentsDir(workroot), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}.json`);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function readAgents(workroot) {
  const dir = agentsDir(workroot);
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f), [])).filter((a) => a && a.id);
}

function writeAgent(workroot, record) {
  mkdirSync(agentsDir(workroot), { recursive: true });
  const file = agentFile(workroot, record.id);
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n');
  renameSync(`${file}.tmp`, file); // atomic: parallel joins never see a half-written file
}

function pruneAgents(workroot, now = Date.now()) {
  for (const a of readAgents(workroot)) {
    const leftAt = a.left?.at ? Date.parse(a.left.at) : null;
    const updated = Date.parse(a.updated || a.started || 0);
    if ((leftAt && now - leftAt > AGENT_LEFT_KEEP_MS) || (!leftAt && now - updated > AGENT_STALE_MS)) {
      try { unlinkSync(agentFile(workroot, a.id)); } catch { /* already gone */ }
    }
  }
}

// a stable name: the pool entry the id hashes to, probing past names live agents of the same level hold
function assignName(workroot, record, cfg) {
  const pool = cfg.names[POOLS[record.level]];
  const taken = new Set(readAgents(workroot).filter((a) => a.id !== record.id && a.level === record.level && !a.left).map((a) => a.name));
  const start = parseInt(createHash('sha1').update(record.id).digest('hex').slice(0, 8), 16) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const name = pool[(start + i) % pool.length];
    if (!taken.has(name)) return name;
  }
  return `${pool[start]} 2`;
}

function agentJoin(workroot, payload) {
  const usage = 'usage: agent join <workroot> \'{ "id", "level", "stage", "role"?, "ticket"?, "repo"?, "parent"?, "rating"? }\'';
  if (!workroot) { console.error(usage); process.exit(2); }
  if (!isDir(workroot)) mkdirSync(workroot, { recursive: true }); // a fresh install's first agent joins before any ticket exists
  let p;
  try { p = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { console.error(`${usage}\n${e.message}`); process.exit(2); }
  if (!p || typeof p.id !== 'string' || !/^\S+$/.test(p.id)) { console.error(`${usage}\nid must be a non-empty string without spaces`); process.exit(2); }
  if (!LEVELS.includes(p.level)) { console.error(`${usage}\nlevel must be one of ${LEVELS.join(', ')}`); process.exit(2); }
  if (typeof p.stage !== 'string' || !p.stage) { console.error(`${usage}\nstage is required`); process.exit(2); }
  const cfg = officeConfig(workroot);
  pruneAgents(workroot);
  const prev = readAgents(workroot).find((a) => a.id === p.id);
  const now = nowIso();
  const record = {
    id: p.id,
    name: prev?.name || assignName(workroot, p, cfg),
    level: p.level,
    role: typeof p.role === 'string' && p.role ? p.role : p.level,
    ticket: typeof p.ticket === 'string' && p.ticket ? p.ticket : null,
    stage: p.stage,
    repo: typeof p.repo === 'string' && p.repo ? p.repo : null,
    parent: typeof p.parent === 'string' && p.parent ? p.parent : null,
    rating: RATING_VALUES.includes(p.rating) ? p.rating : null,
    started: prev?.started || now,
    updated: now,
    left: null,
  };
  writeAgent(workroot, record);
  return record;
}

const RATING_VALUES = ['low', 'medium', 'high'];
const LEAVE_STATUSES = { done: 'done', stopped: 'stopped', gone: 'gone', error: 'gone' };

function agentLeave(workroot, id, status = 'done') {
  if (!isDir(workroot) || !id) { console.error('usage: agent leave <workroot> <id> [done|stopped|gone]'); process.exit(2); }
  const prev = readAgents(workroot).find((a) => a.id === id);
  if (!prev) return { id, left: null, note: 'unknown agent' };
  const record = { ...prev, updated: nowIso(), left: { at: nowIso(), status: LEAVE_STATUSES[status] || 'done' } };
  writeAgent(workroot, record);
  return record;
}

// the status the office shows for one agent, from its record, its stage and its relatives
function agentStatus(a, agents, ticketState, entries, now) {
  if (a.left) return { status: a.left.status, since: a.left.at, question: null };
  const byId = Object.fromEntries(agents.map((x) => [x.id, x]));
  for (let p = a.parent && byId[a.parent]; p; p = p.parent && byId[p.parent]) if (p.left) return { status: 'gone', since: p.left.at, question: null };
  if (!ticketState) return { status: now - Date.parse(a.started) > LOCK_STALE_MS ? 'gone' : 'working', since: a.started, question: null };
  const idle = ticketState.lastEvent ? now - Date.parse(ticketState.lastEvent.ts) > LOCK_STALE_MS : false;
  if (idle || ticketState.lock?.stale) return { status: 'gone', since: ticketState.lastEvent?.ts || a.started, question: null };
  const children = agents.filter((x) => x.parent === a.id && !x.left);
  if (children.some((c) => agentStatus(c, agents, ticketState, entries, now).status === 'working')) return { status: 'working', since: a.started, question: null };
  if (a.level === 'manager') return ticketState.lock && !ticketState.lock.stale ? { status: 'working', since: a.started, question: null } : { status: 'gone', since: a.started, question: null };
  const stage = ticketState.stages.find((s) => s.name === a.stage) || (EXTRA_STAGES.has(a.stage) ? stageStatus(entries, a.stage) : null);
  const st = stage?.status || 'pending';
  const question = st === 'stopped' && ticketState.stopped?.stage === a.stage ? ticketState.stopped.question : null;
  const map = { 'in-progress': 'working', stopped: 'stopped', done: 'done', stale: 'gone', pending: 'working' };
  return { status: map[st] || 'working', since: stage?.at || a.started, question };
}

function office(workroot) {
  const cfg = officeConfig(workroot);
  const now = Date.now();
  const problems = [];
  const dirs = ticketDirs(workroot);
  const states = Object.fromEntries(dirs.map((d) => { const s = computeState(d); return [s.id, { state: s, entries: parseProgress(d, []), dir: d }]; }));
  const rows = dirs.map(rowOf);
  const agents = readAgents(workroot).map((a) => {
    const t = a.ticket ? states[a.ticket] : null;
    const st = agentStatus(a, readAgents(workroot), t?.state || null, t?.entries || [], now);
    const suffix = a.stage.includes(':') ? a.stage.split(':')[1] : null;
    const projects = a.level === 'manager' ? [] : a.repo ? [a.repo] : suffix ? [suffix] : t ? repoNames(readJson(join(t.dir, 'ticket.json'), []), []) : [];
    return { ...a, ...st, projects };
  });
  const active = new Set(agents.filter((a) => a.ticket).map((a) => a.ticket));
  const tickets = rows.filter((r) => r.status !== 'done' || active.has(r.id));
  const names = new Set(cfg.projects);
  for (const r of tickets) for (const n of r.repos || []) names.add(n);
  for (const a of agents) for (const n of a.projects) names.add(n);
  const projects = [...names].map((name) => ({ name, tickets: tickets.filter((r) => (r.repos || []).includes(name)).map((r) => r.id) }));
  for (const r of rows) for (const p of r.problems || []) problems.push(`${r.id}: ${p}`);
  const claudeDir = dirname(resolve(workroot));
  // the day board: the latest plan with live statuses (day.mjs status, dry — the rows are the ones computed above)
  let day = null;
  try { day = dayStatus(workroot, null, { rows: Object.fromEntries(rows.map((r) => [r.id, r])) }); } catch (e) { day = { error: e.message }; }
  // the last usage reading pick recorded, and the last preflight (README § Models and budget; § Using it, Preflight)
  const budgetFile = readJson(join(workroot, '_budget.json'), []);
  const budget = budgetFile && budgetFile.at ? { ...budgetFile, ageMin: Math.max(0, Math.round((now - Date.parse(budgetFile.at)) / 60000)) } : null;
  const doctorFile = readJson(join(workroot, '_doctor.json'), []);
  const doctor = doctorFile && doctorFile.at ? {
    at: doctorFile.at, ok: doctorFile.ok !== false, ageHours: Math.max(0, Math.round((now - Date.parse(doctorFile.at)) / 360000) / 10),
    counts: ['ok', 'warn', 'fail'].reduce((c, k) => ({ ...c, [k]: (doctorFile.checks || []).filter((x) => x.status === k).length }), {}),
    checks: Array.isArray(doctorFile.checks) ? doctorFile.checks : [],
  } : null;
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const totalsAll = totals(workroot, { claudeDir });
  return {
    team: cfg.team, generatedAt: nowIso(), poll: cfg.poll, linger: cfg.linger, projects, tickets, agents, problems,
    inbox: inbox(workroot, now), day, budget, doctor,
    totals: { ...totalsAll, today: totals(workroot, { claudeDir, date: todayStr }) },
  };
}

// the fields a spawner routes on (README § Definitions, Dedicated agent; the runner's rows) — never the stage list or the PRs
function brief(s) {
  const { id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems } = s;
  return { id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems };
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// `--key value` pairs from the tail of an argv
function flags(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) if (String(list[i]).startsWith('--')) o[list[i].slice(2)] = list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[++i] : true;
  return o;
}

process.stdout.on('error', () => {}); // a closed pipe must never undo a log line already appended

const [, , cmd, target, ...rest] = process.argv;
switch (cmd) {
  case 'log': log(target, rest[0], rest[1], rest[2], rest[3]); break;
  case 'state': { const s = computeState(target); emit(flags(rest).brief ? brief(s) : s); break; }
  case 'check': { const s = computeState(target); emit(s, s.problems.length ? 1 : 0); break; }
  case 'all': emit(all(target)); break;
  case 'durations': emit(durations(target)); break;
  case 'usage': { const o = flags(rest); emit(usage(target, { claudeDir: o.claude, date: o.date })); break; }
  case 'totals': { const o = flags(rest); emit(totals(target, { claudeDir: o.claude, date: o.date })); break; }
  case 'inbox': emit(inbox(target)); break;
  case 'answer': {
    // answer <workroot> <id> <stage> '<text>' [--by x] | answer <workroot> <id> --consume|--peek
    if (rest[1] === '--consume' || rest[1] === '--peek') emit(answerTake(target, rest[0], rest[1]));
    else { const o = flags(rest.slice(3)); emit(answerQueue(target, rest[0], rest[1], rest[2], o.by)); }
    break;
  }
  case 'blockers': emit(recordBlockers(target, rest[0])); break;
  case 'actual': emit(recordActual(target, rest[0])); break;
  case 'lock': lockRun(target, rest[0]); break;
  case 'unlock': unlockRun(target, rest[0], rest.includes('--force')); break;
  case 'agent': {
    // agent join <workroot> '<json>' | agent leave <workroot> <id> [status]
    if (target === 'join') emit(agentJoin(rest[0], rest[1]));
    else if (target === 'leave') emit(agentLeave(rest[0], rest[1], rest[2]));
    else { console.error('usage: state.mjs agent join|leave <workroot> …'); process.exit(2); }
    break;
  }
  case 'office': emit(office(target)); break;
  default: console.error('usage: state.mjs log|state|check|all|durations|usage|totals|inbox|answer|blockers|actual|lock|unlock|agent|office <path> …'); process.exit(2);
}
