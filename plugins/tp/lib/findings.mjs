#!/usr/bin/env node
// A review pass as data, on the command line (lib/contract/findings.mjs has the rules; schemas/review-findings.schema.json the shape).
//
//   node findings.mjs check   <review.json>   -> { ok, errors }                                      exit 0 valid, 1 invalid
//   node findings.mjs verdict <review.json>   -> PASS | PASS WITH WARNINGS | BLOCK                    (one word on stdout)
//   node findings.mjs render  <review.json>   -> the PR comment, in the format /tp:review posts      (markdown on stdout)
//   node findings.mjs row     <review.json>   -> { round, sha, verdict, open, new } — the row for pr.json's `reviews`
//   node findings.mjs score   <review.json>   -> { open, resolved, preexisting, score } per priority P0–P4
//   node findings.mjs record  <review.json> <workdir> [--repo <name>]
//                                              -> appends the pass to pr[.<repo>].json and quality.json (validated writes); { row, quality }
// Every subcommand refuses (exit 1, the errors on stderr) a file that does not match the schema.
import { existsSync, readFileSync } from 'node:fs';
import { loadSchema, validate } from './contract/index.mjs';
import { renderReview, rowOf, verdictOf } from './contract/findings.mjs';
import { scoreOf } from './contract/quality.mjs';
import { CliError } from './state/util.mjs';
import { recordReview } from './state/review.mjs';

const [, , cmd, file, ...rest] = process.argv;
const usage = () => { console.error('usage: findings.mjs check|verdict|render|row|score <review.json> | record <review.json> <workdir> [--repo <name>]'); process.exit(2); };
if (!['check', 'verdict', 'render', 'row', 'score', 'record'].includes(cmd) || !file || !existsSync(file)) usage();

let review;
try { review = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`${file} is not valid JSON: ${e.message}`); process.exit(1); }
const errors = validate(loadSchema('review-findings'), review, { load: loadSchema });
if (cmd === 'check') process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`, () => process.exit(errors.length ? 1 : 0));
else if (errors.length) { console.error(`${file} does not match schemas/review-findings.schema.json\n${errors.slice(0, 15).map((e) => `  ${e}`).join('\n')}`); process.exit(1); }
else if (cmd === 'verdict') process.stdout.write(`${verdictOf(review)}\n`);
else if (cmd === 'render') process.stdout.write(renderReview(review));
else if (cmd === 'row') process.stdout.write(`${JSON.stringify(rowOf(review))}\n`);
else if (cmd === 'score') process.stdout.write(`${JSON.stringify(scoreOf(review))}\n`);
else {
  const repoAt = rest.indexOf('--repo');
  try { process.stdout.write(`${JSON.stringify(recordReview(rest[0], review, { repo: repoAt >= 0 ? rest[repoAt + 1] : '' }))}\n`); } catch (e) { if (!(e instanceof CliError)) throw e; console.error(e.message); process.exit(e.code); }
}
