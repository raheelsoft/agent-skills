// review.mjs — what one review pass leaves in the work directory. recordReview appends the pass to `pr[.repo].json` (its row, the round count, the
// current verdict) and to `quality.json` (what was left open per priority), both through the validated writer — so the loop's history is never typed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, readJson } from './util.mjs';
import { putArtifact } from './put.mjs';
import { aggregate, rowOf, scoreOf } from '../contract/index.mjs';

/** Record a review pass (the parsed review-findings JSON) for `repo` ('' for a single-repo ticket). Returns the row and the ticket's quality. */
export function recordReview(workdir, review, { repo = '' } = {}) {
  const prName = repo ? `pr.${repo}` : 'pr';
  const prFile = join(workdir, `${prName}.json`);
  if (!existsSync(prFile)) throw new CliError(`${prName}.json is not in ${workdir}: a review is recorded against the PR it reviewed`, 2);
  const pr = readJson(prFile, []);
  if (!pr) throw new CliError(`${prName}.json is not valid JSON`, 2);

  const row = rowOf(review);
  const reviews = [...(Array.isArray(pr.reviews) ? pr.reviews.filter((r) => r.round !== row.round) : []), row].sort((a, b) => a.round - b.round);
  putArtifact(workdir, prName, { reviews, reviewRounds: reviews.length, verdict: row.verdict }, { merge: true });

  const counts = scoreOf(review);
  let rounds = [];
  const qFile = join(workdir, 'quality.json');
  if (existsSync(qFile)) { try { rounds = JSON.parse(readFileSync(qFile, 'utf8')).rounds || []; } catch { rounds = []; } }
  const name = pr.repo || repo || 'repo';
  rounds = [...rounds.filter((r) => !(r.repo === name && r.round === review.round)), { repo: name, round: review.round, sha: review.sha, mode: review.mode, verdict: row.verdict, open: counts.open, resolved: counts.resolved, preexisting: counts.preexisting, score: counts.score }]
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.round - b.round);
  putArtifact(workdir, 'quality', { rounds, ...aggregate(rounds) });
  return { row, quality: { ...aggregate(rounds), rounds: rounds.length } };
}
