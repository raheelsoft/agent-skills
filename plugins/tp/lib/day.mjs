#!/usr/bin/env node
// day.mjs — the day planner's arithmetic (skills/plan-day/SKILL.md): which of a day's candidate tickets
// run, in what order, and how many at once — deterministic, so the same day plans the same way twice.
// It reads the state script's rows for the work root and its own plan file; it writes only
// <workroot>/_day/<date>.json (the contract) and <workroot>/_day/<date>.md (for people).
//
//   node day.mjs plan <workroot> '<json>'            -> selects, orders, writes the plan; returns it with `start` — or, with
//                                                       `review: true`, as a PROPOSAL: nothing starts, `proposed` holds what would,
//                                                       `question` is the approval stop, also written to _scratch/plan-day-<date>.stop.json
//                                                       so the inbox and the office list it; `drop`/`only`/`first`/`lanes` are the
//                                                       person's adjustments on a re-plan
//   node day.mjs approve <workroot> <date> ['<json>']  -> the person's go-ahead: marks the plan approved, removes the stop, starts
//                                                       what is ready (a real advance); { by?, now? }
//   node day.mjs advance <workroot> <date> ['<json>'] -> refreshes every ticket's status from the work directories;
//                                                       returns what starts now, what waits on what, what resumes by itself
//                                                       (`resumable`: a usage pause past its reset, a parked ticket whose blockers
//                                                       are resolved) and, given `recheck`, re-queues skipped-blocked candidates
//                                                       whose blockers are now resolved (`unblocked`)
//   node day.mjs eod <workroot> <date> ['<json>']     -> the day's end: what finished, what stands where, estimate vs actual vs the
//                                                       pipeline's minutes, tokens and cost, tomorrow's carry-over, the calibration
//                                                       drift — written to <workroot>/_day/<date>.eod.json (/tp:eod writes the .md)
//   node day.mjs show <workroot> <date>              -> the plan as stored
//   node day.mjs status <workroot> [<date>]          -> the plan (the date's, else the latest) with live statuses — a dry
//                                                       advance that writes nothing; `stale` when the plan is older than today
//   node day.mjs lanes <band> [<.claude>]            -> { band, lanes, draw } from tiers.json.day
//
// plan input: { date?: "YYYY-MM-DD" (today), from: "sprint"|"pool", iteration?, features?: [], claudeDir?,
//               lanes?: n | band?: ample|economy|stop, count?: n, stackable?: bool, dry?: bool, seed?, now?,
//               hours?: n, focus?: 0–1 (today's workday, over tiers.json.day),
//               tickets: [{ id, title?, rating?, priority?, after?: [ids], blocked?: "<why>", soft?: "<why>", inFlight?: bool,
//                           hours?: n (the person's focused hours — the tracker's estimate converted, or given),
//                           repos?, flags?, unclear?, novelty? (estimate signals when `hours` is absent — model.mjs estimate) }] }
//   review    true → a proposal for the person (nothing starts until `approve`); false/absent → approved as planned
//   drop      ids the person took out (a dependent of a dropped ticket is skipped with it); only: keep these and their
//             prerequisites, nothing else; first: these ids run first, in this order (before priority and carry-over)
//   after     candidates this one must follow (the tracker's blocked-by relations, stated dependencies)
//   blocked   an unresolved blocker outside the candidates — skipped, never planned
//   soft      only soft-blocked (start-ticket's blocked-check.md) — skipped; the person may start it by hand
//   inFlight  already in the pipeline (a work directory exists) — listed, never selected, a valid `after` target
//   count     at most this many tickets (a sprint day takes every ticket that qualifies; a pool day draws
//             `draw`); a dependent is only taken with its prerequisites
//   lanes     runs at once — given (a number, or "all"), or from the band through tiers.json.day: every ticket
//             that is ready — unblocked, no unfinished prerequisite — starts in parallel unless the usage band caps
//             it (`ample`/`unknown` "all", `economy` 1, `stop` 0); `stackable` (the project stacks dependent work on
//             the open branch) lets a dependent start once its prerequisite's PR is open instead of merged
//   hours     the day is a PERSON's day (model.mjs DEFAULT_DAY): `hours` × `focus` focused hours a day, `switch`
//             hours lost per extra ticket in a day, `slack` a day may run over, `attend` the share of a running
//             ticket's estimate the person still spends on it. Tickets are placed first-fit into consecutive
//             workdays (Mon–Fri) in plan order; one that does not fit what is left of a day starts anyway and
//             carries over (`carry`); a dependent never starts before the day its prerequisite ends. The days are
//             the PERSON's attention forecast, never a gate on the pipeline: `start` is every ready ticket up to
//             the free lanes, whatever day it was placed on; a dependent starts the moment its prerequisites are
//             satisfied.
// advance input: { lanes? | band?, stackable?, dry?, now?, claudeDir?,
//                  recheck?: { "<id>": [{ id, state, resolved, soft, checkedAt? }] } }  — `dry` computes `start` without marking
//                it started; `recheck` is the blocker lookup's result (start-ticket/instructions/blocked-check.md § Re-check) for
//                skipped-blocked candidates: recorded on the plan, and a candidate whose blockers are all resolved (or only soft)
//                is re-queued and scheduled behind what is already planned
//
// tiers.json.day (defaults): { lanes: { ample: "all", economy: 1, stop: 0, unknown: "all" }, draw: 6,
//                               hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true }

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, advance, approve, show, status, eod, lanesInfo } from './day/index.mjs';

// the library, for whoever imports this file (the state script's office, the tests): everything but the command line lives in day/
export * from './day/index.mjs';

function readArg(arg) {
  if (arg == null || arg === '') return {};
  if (existsSync(arg)) return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(arg);
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, target, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'plan': emit(plan(target, readArg(rest[0]))); break;
      case 'advance': emit(advance(target, rest[0], readArg(rest[1]))); break;
      case 'approve': emit(approve(target, rest[0], readArg(rest[1]))); break;
      case 'show': emit(show(target, rest[0])); break;
      case 'status': { const r = status(target, rest[0] || null, readArg(rest[1])); if (!r) { console.error(`no plan under ${join(target, '_day')}`); process.exit(2); } emit(r); break; }
      case 'eod': emit(eod(target, rest[0] || null, readArg(rest[1]))); break;
      case 'lanes': emit(lanesInfo(target, rest[0])); break;
      default: console.error('usage: day.mjs plan|approve|advance|show|status|eod|lanes …'); process.exit(2);
    }
  } catch (e) {
    if (e.cycle) emit({ error: e.message, cycle: e.cycle }, 1);
    else { console.error(e.message); process.exit(2); }
  }
}
