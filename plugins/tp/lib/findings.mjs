#!/usr/bin/env node
// A review pass as data, on the command line (lib/contract/findings.mjs has the rules; schemas/review-findings.schema.json the shape).
//
//   node findings.mjs check   <review.json> [--criteria <n>] [--scan <diffscan.json>]
//                                              -> { ok, errors }                                      exit 0 valid, 1 invalid; with the flags also: every one of the
//                                                 ticket's n criteria has a row (a missing one carries a P0/P1), every P0/P1 scan hit is raised or dismissed
//   node findings.mjs verdict <review.json>   -> PASS | PASS WITH WARNINGS | BLOCK                    (one word on stdout)
//   node findings.mjs render  <review.json>   -> the PR comment, in the format /tp:review posts      (markdown on stdout)
//   node findings.mjs row     <review.json>   -> { round, sha, verdict, open, new } — the row for pr.json's `reviews`
//   node findings.mjs score   <review.json>   -> { open, resolved, preexisting, score } per priority P0–P4
//   node findings.mjs next    <review.json> <workdir> [--repo r] [--rating low|medium|high] [--files n] [--lines n] [--merge auto|ask] [--standing auto|ask]
//                                                    [--checks pass|fail|pending|none] [--mergeable true|false] [--claude <.claude>]
//                                              -> record, then { row, quality, rounds, decision: { action: merge|ask|fix|stop|sync|wait, why } } — the loop's next step and the merge gate in one call
//   node findings.mjs record  <review.json> <workdir> [--repo <name>]
//                                              -> appends the pass to pr[.<repo>].json and quality.json (validated writes); { row, quality }
// Every subcommand refuses (exit 1, the errors on stderr) a file that does not match the schema.
import { existsSync, readFileSync } from 'node:fs';
import { loadSchema, validate } from './contract/index.mjs';
import { renderReview, rowOf, verdictOf } from './contract/findings.mjs';
import { traceErrors } from './contract/trace.mjs';
import { scoreOf } from './contract/quality.mjs';
import { CliError } from './state/util.mjs';
import { recordReview } from './state/review.mjs';
import { reviewNext, reviewNextArgs } from './state/reviewnext.mjs';

const [, , cmd, file, ...rest] = process.argv;
const usage = () => { console.error('usage: findings.mjs check|verdict|render|row|score <review.json> | record|next <review.json> <workdir> [--repo <name>] …'); process.exit(2); };
if (!['check', 'verdict', 'render', 'row', 'score', 'record', 'next'].includes(cmd) || !file || !existsSync(file)) usage();

let review;
try { review = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`${file} is not valid JSON: ${e.message}`); process.exit(1); }
const flagOf = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const errors = validate(loadSchema('review-findings'), review, { load: loadSchema });
if (cmd === 'check' && !errors.length) {
  let scan = null;
  try { scan = flagOf('--scan') ? JSON.parse(readFileSync(flagOf('--scan'), 'utf8')) : null; } catch (e) { errors.push(`--scan file is not valid JSON: ${e.message}`); }
  const n = flagOf('--criteria');
  errors.push(...traceErrors(review, { criteria: n === undefined ? null : Number(n), scan }));
}
if (cmd === 'check') process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`, () => process.exit(errors.length ? 1 : 0));
else if (errors.length) { console.error(`${file} does not match schemas/review-findings.schema.json\n${errors.slice(0, 15).map((e) => `  ${e}`).join('\n')}`); process.exit(1); }
else if (cmd === 'verdict') process.stdout.write(`${verdictOf(review)}\n`);
else if (cmd === 'render') process.stdout.write(renderReview(review));
else if (cmd === 'row') process.stdout.write(`${JSON.stringify(rowOf(review))}\n`);
else if (cmd === 'score') process.stdout.write(`${JSON.stringify(scoreOf(review))}\n`);
else {
  const repoAt = rest.indexOf('--repo');
  try { process.stdout.write(`${JSON.stringify(cmd === 'next' ? reviewNext(rest[0], review, reviewNextArgs(rest.slice(1))) : recordReview(rest[0], review, { repo: repoAt >= 0 ? rest[repoAt + 1] : '' }))}\n`); } catch (e) { if (!(e instanceof CliError)) throw e; console.error(e.message); process.exit(e.code); }
}
