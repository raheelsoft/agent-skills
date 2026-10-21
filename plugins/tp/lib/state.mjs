#!/usr/bin/env node
// Deterministic state for the ticket workflow (see reference/README.md).
//
// <workdir> may be a bare ticket id (ABC-12): it stands for <.claude>/work/ABC-12 of this project.
//   node state.mjs log   <workdir> <stage> <started|done|stopped|note> <summary> [links]
//   node state.mjs state <workdir>            -> JSON: id, title, link, decision, complexity, estimate, stages, next, stopped, closed, prs, worktrees, lock, retro, lastEvent, problems
//   node state.mjs state <workdir> --brief    -> the decision fields only: id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems
//                                                (what an orchestrator routes on — a tenth of the size; the full form is for a stage's own steps)
//   node state.mjs check <workdir>            -> same as state; exit 1 when problems exist
//   node state.mjs all   <workroot>           -> JSON array, one entry per work directory
//   node state.mjs table <workroot> [problems] -> the status board as a markdown table (one row per ticket), the totals line, problems, leftover worktrees and stale locks —
//                                                what /tp:status relays; `problems` keeps only the tickets that have one
//   node state.mjs route <workdir|id> [--round n] [--force] [--answers t] [--owner o] -> JSON { action: first-run|restart|rerun|run|stop|refuse|error|locked, why, next, answers, … } —
//                                                what /tp:run-ticket does first with a ticket; a queued office answer is consumed here
//   node state.mjs approve <workdir|id> [--by who] -> records a plan's go-ahead (answers.md line, the check's override, the log note); refuses a plan not waiting for one
//   node state.mjs retro-facts <workdir|id> [--claude <.claude>] -> JSON: stops, answers asked, implementation summary, manual criteria, plan-check, review rounds, minutes, tokens, counts
//   node state.mjs inbox <workroot> --render [--date d] [--plan "<line>"] [--dry] -> the report /tp:inbox hands the session, as text
//   node state.mjs show <workdir|id>            -> one ticket in detail as text: stages with minutes, the stop and its resume command, blockers, queued answer, lock, PRs, worktrees,
//                                                problems, the tail of progress.md and the next action (what /tp:status <id> relays)
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
//   node state.mjs put <workdir> <artifact> ['<json>'|--from <file>] [--merge]  -> check the JSON against the artifact's schema (schemas/) and write it; JSON on stdin
//                                                when neither is given. Refuses (exit 2) and writes nothing when it does not conform
//   node state.mjs shape [<artifact>]          -> the form `put` accepts, field by field, in a few lines (no argument: every artifact); implement.<repo> is implement
//   node state.mjs doc <dir> <name> [--append] [--from <file>]  -> write a document (plan.md, report.md, a checkpoint …) into a ticket's work directory, or _scratch or _day;
//                                                the text on stdin when there is no --from. The agents' own tools cannot write under <.claude>/, this can
//   node state.mjs agent join  <workroot> '<json>'          -> register an agent for the office (returns its record, with its name)
//   node state.mjs agent leave <workroot> <id> [done|stopped|gone]  -> mark it gone
//   node state.mjs office <workroot>          -> JSON: team, projects, tickets, agents, inbox, day, budget, doctor, totals — what the office draws
//
// Every stop the state reports carries `kind` (question | approval | error | usage | blocked | problem), `doc` (the file the
// person must read to answer, relative to the WORK ROOT — a plan, named, never inlined), `resumable`, `default`
// and `resume` — the command that continues the ticket (reference/definitions.md § Definitions, Asking the user).
// The logic is in state/*.mjs (index.mjs is its public API for hooks and tests); this file only parses arguments, prints and exits.
// No dependencies beyond the sibling scripts (day.mjs for the day board, setup.mjs for the skill selection).


import { CliError } from './state/util.mjs';
import { resolveWorkdir } from './state/paths.mjs';
import { log } from './state/progress.mjs';
import { lockRun, unlockRun } from './state/lock.mjs';
import { computeState, brief, durations, all, totals } from './state/compute.mjs';
import { usage } from './state/usage.mjs';
import { inbox, answerQueue, answerTake } from './state/inbox.mjs';
import { recordBlockers, recordActual } from './state/records.mjs';
import { putArtifact, payloadText } from './state/put.mjs';
import { writeDoc, docText } from './state/doc.mjs';
import { shape } from './state/shape.mjs';
import { statusTable, showTicket } from './state/table.mjs';
import { routeWorkdir } from './state/route.mjs';
import { approvePlan } from './state/approve.mjs';
import { retroFacts } from './state/retrofacts.mjs';
import { inboxReport } from './state/inboxreport.mjs';
import { agentJoin, agentLeave } from './state/agents.mjs';
import { office } from './state/office.mjs';

function emit(obj, code = 0, compact = false) {
  process.stdout.write(JSON.stringify(obj, null, compact ? 0 : 2) + '\n', () => process.exit(code));
}

// what a command refused with: stdout first when it carries any, then the message, then the exit code
function fail(e) {
  const done = () => { if (e.message) console.error(e.message); process.exit(e.code); };
  if (e.stdout) process.stdout.write(e.stdout, done); else done();
}

// `--key value` pairs from the tail of an argv
function flags(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) if (String(list[i]).startsWith('--')) o[list[i].slice(2)] = list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[++i] : true;
  return o;
}

process.stdout.on('error', () => {}); // a closed pipe must never undo a log line already appended

const [, , cmd, rawTarget, ...rest] = process.argv;
// the commands whose first argument is one ticket's work directory: a bare ticket id stands for it
const PER_TICKET = new Set(['log', 'state', 'check', 'durations', 'usage', 'blockers', 'actual', 'put', 'doc', 'lock', 'unlock', 'route', 'approve', 'retro-facts']);
function dispatch() {
  const target = PER_TICKET.has(cmd) ? resolveWorkdir(rawTarget) : rawTarget;
  switch (cmd) {
    case 'log': process.stdout.write(log(target, rest[0], rest[1], rest[2], rest[3])); break;
    case 'state': { const s = computeState(target); emit(flags(rest).brief ? brief(s) : s); break; }
    case 'check': { const s = computeState(target); emit(s, s.problems.length ? 1 : 0); break; }
    case 'all': emit(all(target)); break;
    case 'show': process.stdout.write(`${showTicket(resolveWorkdir(rawTarget))}\n`); break;
    case 'table': process.stdout.write(`${statusTable(target, { filter: rest[0] })}\n`); break;
    case 'durations': emit(durations(target)); break;
    case 'usage': { const o = flags(rest); emit(usage(target, { claudeDir: o.claude, date: o.date })); break; }
    case 'totals': { const o = flags(rest); emit(totals(target, { claudeDir: o.claude, date: o.date })); break; }
    case 'inbox': { const o = flags(rest); if (o.render) process.stdout.write(`${inboxReport(target, o)}\n`); else emit(inbox(target)); break; }
    case 'route': emit(routeWorkdir(target, flags(rest))); break;
    case 'approve': emit(approvePlan(target, { by: typeof flags(rest).by === 'string' ? flags(rest).by : null })); break;
    case 'retro-facts': emit(retroFacts(target, { claudeDir: flags(rest).claude })); break;
    case 'answer': {
      // answer <workroot> <id> <stage> '<text>' [--by x] | answer <workroot> <id> --consume|--peek
      if (rest[1] === '--consume' || rest[1] === '--peek') emit(answerTake(target, rest[0], rest[1]));
      else { const o = flags(rest.slice(3)); emit(answerQueue(target, rest[0], rest[1], rest[2], o.by)); }
      break;
    }
    case 'blockers': emit(recordBlockers(target, rest[0])); break;
    case 'actual': emit(recordActual(target, rest[0])); break;
    case 'put': { const o = flags(rest.slice(1)); emit(putArtifact(target, rest[0], payloadText({ arg: String(rest[1]).startsWith('--') ? undefined : rest[1], from: o.from }), { merge: o.merge === true }), 0, true); break; }
    case 'shape': process.stdout.write(shape(target) + '\n'); break;
    case 'doc': { const o = flags(rest.slice(1)); emit(writeDoc(target, rest[0], docText({ from: o.from }), { append: o.append === true }), 0, true); break; }
    case 'lock': process.stdout.write(lockRun(target, rest[0])); break;
    case 'unlock': process.stdout.write(unlockRun(target, rest[0], rest.includes('--force'))); break;
    case 'agent': {
      // agent join <workroot> '<json>' | agent leave <workroot> <id> [status]
      if (target === 'join') emit(agentJoin(rest[0], rest[1]));
      else if (target === 'leave') emit(agentLeave(rest[0], rest[1], rest[2]));
      else throw new CliError('usage: state.mjs agent join|leave <workroot> …', 2);
      break;
    }
    case 'office': emit(office(target)); break;
    default: throw new CliError('usage: state.mjs log|state|check|all|durations|usage|totals|inbox|answer|blockers|actual|put|lock|unlock|agent|office <path> …', 2);
  }
}

try { dispatch(); } catch (e) { if (e instanceof CliError) fail(e); else throw e; }
