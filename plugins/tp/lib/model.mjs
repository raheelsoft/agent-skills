#!/usr/bin/env node
// The deterministic half of reference/models-and-budget.md § Models and budget. The rubric there rates a task
// low | medium | high; this script turns numbers into a rating, a usage reading into a budget band,
// and a rating into the model and effort to spawn with — from the environment's own tiers.json,
// never from a name written into a skill.
//
//   node model.mjs rate   <signals.json | '{…}'>              -> { rating, score, why }
//   node model.mjs budget <usage.json | '{…}'> [tiers.json]   -> { band, binding, windows, tiers, why }
//   node model.mjs pick   <task.json | '{…}'>                 -> { action, rating, model, effort, budget, why }
//   node model.mjs triage '{ criteria, files, areas, pattern, dataModel, access, contract, repos, irreversible, sharedEnv, questions, epic, derived, uncertain }'
//                                                             -> { decision: needs-input|plan|direct, complexity, why, columns } — the triage rubric over the evidence rows the agent judged
//   node model.mjs rounds <review.json | '{…}'>               -> { cap, round, next, mode, open, why }
//   node model.mjs compact <context.json | '{…}'>             -> { action, rating, used, window, headroom, need, threshold, handoffs, why }
//   node model.mjs retry '{ rating, kind, attempts, claudeDir }' -> { action: retry|fallback|escalate, kind, rating, attempts, max, waitSeconds, why }
//   node model.mjs estimate '{ rating, repos, flags, unclear, novelty, claudeDir }' -> { focusedHours, calendarHours, days, points, perDay, basis, why }
//   node model.mjs calibrate '{ workroot, claudeDir, minSamples? }' [--apply] -> { samples, ratings: { <rating>: { samples, current, medianRatio,
//                                                proposed, pipelineMedianMin, ids } }, drift, applied } — the base hours proposed from the
//                                                person's recorded actuals (reference/models-and-budget.md § Models and budget, Estimates); --apply writes them
//   node model.mjs tiers  <.claude> ceiling=<model> [ladder=<smallest>,…,<largest>] [low=<model> medium=<model> high=<model>]
//                                                             -> writes <.claude>/tiers.json: the ceiling, the ladder and the three tiers derived from
//                                                                them (low = the smallest model, high = the ceiling, medium = the first step up); a tier
//                                                                named by hand must sit on the ladder at or below the ceiling
//   node model.mjs tiers  <.claude> low=<model> medium=<model> high=<model>   -> the three tiers by hand (checked against the ceiling when there is one)
//   node model.mjs ceiling '{ claudeDir, session? }'          -> { ceiling, ladder, allowed, tiers, problems, startup, session } — what the pipeline may use,
//                                                                and where the project's starting model and a named session model sit against it
//   node model.mjs pin    <.claude>                           -> writes the ceiling as the runtime's `model` setting in <.claude>/settings.local.json when
//                                                                that is unset or above it — the session's starting model, which is not a cap
//
// signals: { steps, flags: [] | n, files, lines, repos, criteria, round, retries, unclear, mechanical, claudeDir? }
// Every command takes claudeDir (or tiers) so tiers.json's mapping and overrides apply; without it the
// defaults apply and pick returns model: null.
// usage:   the runtime's reading — { windows: [{ label, percentUsed, resetsAt }] } (extra fields ignored;
//          the app's { plan: { windows } } shape is accepted as is)
// task:    { rating, catching?, mechanical?, floor?, usage?, tiers?, claudeDir?, now?, record? }
//   rating    the rubric's rating (or `rate`'s — the higher wins, decided by the caller)
//   catching  work that exists to catch what others missed (a check, a review, evidence): one effort step up
//   mechanical the contract is a command, a lookup or a format: eligible for the economy step-down
//   floor     tier= from the invocation: no rating below it
//   record    (default true) with claudeDir and a usage reading that has windows, pick records the reading in
//             <claudeDir>/work/_budget.json — the budget gauge the office and /tp:eod show — as a side effect
// review:  { rating, files, lines, history: [{ round, open: [ids], new: [ids] }, …] } — one entry per pass posted so far
// context: { rating, used (tokens the agent estimates it holds) | percentUsed, window?, stepsLeft, stepsTotal?,
//            nextStep?: { bytes } (what the next step must read), handoffs? (hand-offs so far), perStep? }
// ceiling, ladder: the largest model the pipeline may use, and the runtime's models smallest first (reference/models-and-budget.md § Models and budget, The
//          ceiling) — both are data, no script names a model; every tier sits on the ladder at or below the ceiling, and pick clamps one that does not
// tiers.json: { ceiling?, ladder?, low, medium, high, budget?: { economy: 70, stop: 90 }, thresholds?: { medium: 2, high: 4 },
//               review?: { low: 2, medium: 3, high: 4, max: 5 },
//               compact?: { window: 200000, reserve: 0.08, perStep: { low: 0.04, medium: 0.08, high: 0.12 },
//                           safety: { low: 1.2, medium: 1.5, high: 2 }, handoffs: { low: 2, medium: 4, high: 6 } },
//               retries?: { low: 1, medium: 2, high: 3 } (auto-resolve bound, reference/failures-and-stops.md § Failures and escalation),
//               estimate?: { base: { low: 2, medium: 6, high: 16 }, perRepo: 0.25, perFlag: 0.15, unclear: 0.3, novelty: 0.2,
//                            overhead: 0.35, unitHours: null, minSamples: 3 } (a person's focused hours — reference/models-and-budget.md § Models and budget,
//                            Estimates; minSamples: actuals per rating before calibrate proposes a base),
//               day?: { lanes: { ample: "all", economy: 1, stop: 0, unknown: "all" }, draw: 6,  (day.mjs: lanes and the pool draw)
//                       hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true,  (the person's workday, dayConfig)
//                       start: "09:00", end: "18:00", advanceEvery: 30 },                          (/tp:schedule: the scheduled day's window)
//               prices?: { low, medium, high } ($ per 1M tokens, blended — state.mjs usage prices "tokens=<n> tier=<rating>" notes),
//               doctor?: { maxAgeHours: 24, timeoutMs: 8000, checks: [{ name, run: [argv], expect? }] } (doctor.mjs: the preflight) }
// No dependencies.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTiers } from './model/common.mjs';
import { rate, triage, budget, pick, rounds, compact, retry, estimate, calibrate, writeTiers, ceilingStatus, pinSession } from './model/index.mjs';

// the library, for whoever imports this file (hooks, doctor, day.mjs, the tests): everything but the command line lives in model/
export * from './model/index.mjs';

function readArg(arg) {
  if (arg == null) return {};
  if (existsSync(arg)) return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(arg);
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, a, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'rate': { const s = readArg(a); emit(rate(s, s.thresholds || readTiers(s).thresholds)); break; }
      case 'budget': { const u = readArg(a); emit(budget(u, rest[0] ? readArg(rest[0]) : {})); break; }
      case 'pick': emit(pick(readArg(a))); break;
      case 'rounds': emit(rounds(readArg(a))); break;
      case 'triage': emit(triage(readArg(a))); break;
      case 'compact': emit(compact(readArg(a))); break;
      case 'retry': emit(retry(readArg(a))); break;
      case 'estimate': emit(estimate(readArg(a))); break;
      case 'calibrate': emit(calibrate({ ...readArg(a), apply: rest.includes('--apply') })); break;
      case 'tiers': { if (!a) throw new Error('usage: tiers <.claude> ceiling=<model> [ladder=<smallest>,…,<largest>] | low=… medium=… high=…'); emit(writeTiers(a, rest)); break; }
      case 'ceiling': emit(ceilingStatus(readArg(a))); break;
      case 'pin': { if (!a) throw new Error('usage: pin <.claude>'); emit(pinSession(a)); break; }
      default: console.error('usage: model.mjs rate|triage|budget|pick|rounds|compact|retry|estimate|calibrate|tiers|ceiling|pin …'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
}
