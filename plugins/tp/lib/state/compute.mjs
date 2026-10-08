// compute.mjs — the ticket's state, computed from its files — nothing is stored: computeState and its brief form, the durations, one row per ticket for the
// office and the status board, the tickets under a work root, and the totals over all of them.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { offStages } from '../setup.mjs';
import { EXTRA_STAGES, ORDER, PER_REPO } from './constants.mjs';
import { countOf, isDir, questionText, readJson, recordedPath } from './util.mjs';
import { parseProgress } from './progress.mjs';
import { blockedByOf, expectedStages, goAhead, readRetro, repoNames, stageStatus } from './stages.mjs';
import { readLock } from './lock.mjs';
import { classifyStop } from './classify.mjs';
import { usage } from './usage.mjs';
import { pendingAnswer } from './answers.mjs';
import { worktreesOnDisk as onDisk } from './paths.mjs';

export function computeState(workdir) {
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
    // every plan waits for the person's approval (reference/using.md § Using it, When it stops) — a check still saying `revise`
    // presents its open findings as the risks the person may accept
    const blocking = (check?.findings || []).filter((f) => f.severity === 'blocking').length;
    const flags = Array.isArray(plan.flags) && plan.flags.length ? plan.flags.map(questionText).join(', ') : 'none';
    if (plan.status === 'open-questions') wait(planStage, `open questions in plan.md (${countOf(plan.openQuestions)})`);
    else if (check && !goAhead(answers, ticket?.round)) {
      if (check.verdict === 'revise' && !check.override) wait(planStage, `approval needed: ${countOf(plan.steps)} steps, risks: ${flags} — the check still has ${blocking} blocking finding(s); approve as is (go-ahead) or send a change`);
      else wait(planStage, `approval needed: ${countOf(plan.steps)} steps, risks: ${flags} — approve (go-ahead) or send a change`);
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

  // worktrees: expected from ticket.json while the ticket is open; present on disk under <.claude>/worktrees/<id>/ (or the wt/ an earlier pickup made)
  const worktreesOnDisk = onDisk(workdir);
  const started = out.some((s) => s.name === 'start-ticket' && s.status === 'done');
  if (ticket && Array.isArray(ticket.repos) && started) {
    for (const r of ticket.repos) {
      if (!r?.worktree || !r?.branch) continue;
      const name = r.name || basename(r.path || '');
      // the worktree lives from pickup to the end of the run (reference/work-directory.md § Worktrees); it must be on the ticket's branch
      // until this repo's PR is merged — afterwards accept may detach it at the merge commit, so nothing is checked
      const mergeStage = repos.length > 1 ? `merge:${name}` : 'merge';
      if (out.some((s) => s.name === mergeStage && s.status === 'done')) continue;
      const path = recordedPath(r.worktree, workdir);
      if (!isDir(path)) { problems.push(`worktree for ${name} missing: ${r.worktree}`); continue; }
      try {
        const head = execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
        if (head !== r.branch) problems.push(`worktree for ${name} is on "${head}", ticket.json says "${r.branch}"`);
      } catch (e) { problems.push(`worktree for ${name} is not a git checkout: ${r.worktree}`); }
    }
  }

  const prFiles = repos.length > 1 ? repos.map((r) => `pr.${r}.json`) : ['pr.json'];
  const prs = prFiles.map((f) => readJson(join(workdir, f), problems)).filter(Boolean);
  const qualityDoc = readJson(join(workdir, 'quality.json'), []); // what the review passes left open per priority (findings.mjs record)
  return {
    id: ticket?.id || basename(workdir),
    title: ticket?.title || null,
    link: ticket?.link || null,
    decision: triage?.decision || null,
    // the ticket's current complexity rating: the plan's, else triage's, else the pickup's (reference/models-and-budget.md § Models and budget)
    complexity: plan?.complexity || triage?.complexity || ticket?.complexity || null,
    // the person's hours (reference/models-and-budget.md § Models and budget, Estimates): triage's refinement, else the pickup's
    estimate: triage?.estimate || ticket?.estimate || null,
    // the person's actual hours, when /tp:eod recorded them (reference/models-and-budget.md § Models and budget, Estimates)
    actual: ticket?.actual && Number(ticket.actual.focusedHours) > 0 ? ticket.actual : null,
    blockedBy,
    unblocked,
    stages: out,
    next,
    stopped,
    closed,
    prs,
    quality: qualityDoc && qualityDoc.open ? { verdict: qualityDoc.verdict ?? null, open: qualityDoc.open, score: qualityDoc.score ?? 0 } : null,
    worktrees: worktreesOnDisk,
    lock: readLock(workdir),
    retro: readRetro(workdir, problems),
    lastEvent: entries[entries.length - 1] || null,
    problems,
  };
}

export function durations(workdir) {
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

// the same over every ticket of a work root, plus how many tickets stand where
export function totals(workroot, opts = {}) {
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

// one ticket's row, as `all` and `office` list it
export function rowOf(d) {
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
      quality: s.quality,
      worktrees: s.worktrees,
      lock: s.lock ? { owner: s.lock.owner, since: s.lock.since, stale: s.lock.stale } : null,
      retro: s.retro,
      problems: s.problems,
      durations: mins,
      tokens: u.total, cost: u.cost, tokensUnpriced: u.unpriced, tokensPartial: u.partial,
      // an answer queued for the current stop (office or `state.mjs answer`), taken by the next invocation (reference/definitions.md § Definitions, Resume)
      answer: queued && s.stopped && queued.stage === s.stopped.stage && queued.at === s.stopped.at ? { text: queued.answer, queuedAt: queued.queuedAt, by: queued.by } : null,
    };
  } catch (e) {
    return { id: basename(d), status: 'error', problems: [String(e.message)] };
  }
}

// the ticket directories under a work root: never the `_`-prefixed ones (_office, _scratch)
export function ticketDirs(workroot) {
  if (!isDir(workroot)) return [];
  return readdirSync(workroot)
    .filter((n) => !n.startsWith('_'))
    .map((d) => join(workroot, d))
    .filter((d) => isDir(d) && existsSync(join(d, 'progress.md')));
}

export function all(workroot) {
  return ticketDirs(workroot).map(rowOf);
}

// the fields a spawner routes on (reference/definitions.md § Definitions, Dedicated agent; the runner's rows) — never the stage list or the PRs
export function brief(s) {
  const { id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems } = s;
  return { id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems };
}
