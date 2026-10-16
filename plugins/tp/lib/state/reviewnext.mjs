// reviewnext.mjs — after a review pass: record it, ask the loop what comes next and decide the merge, in one call. The orchestrator used to assemble
// `{ rating, files, lines, history }` by hand from `git diff --stat` and the posted trailers, run `rounds`, then argue the merge conditions out of four
// paragraphs; here the history is the one `pr.json` already holds, the loop's answer is `model.mjs rounds`, and the merge is `mergeDecision` — so a merge
// with an open P0/P1 cannot be the outcome (skills/merge/instructions/review-loop.md).
import { join } from 'node:path';
import { readJson } from './util.mjs';
import { recordReview } from './review.mjs';
import { rounds } from '../model/index.mjs';
import { mergeDecision } from '../contract/mergegate.mjs';

const NEXT = { merge: 'merge', stop: 'stop', review: 'fix' };

/** `--rating low --files 3 --lines 40 --merge auto --standing ask --checks pass --mergeable true --claude <dir> --repo name` → options. */
export function reviewNextArgs(rest) {
  const o = {};
  for (let i = 0; i < rest.length; i += 2) if (String(rest[i]).startsWith('--')) o[rest[i].slice(2)] = rest[i + 1];
  return {
    repo: o.repo || '', rating: o.rating, files: Number(o.files) || 0, lines: Number(o.lines) || 0, claudeDir: o.claude,
    merge: o.merge || null, standing: o.standing || null, checks: o.checks || null,
    mergeable: o.mergeable === undefined ? null : o.mergeable === 'true',
  };
}

/** -> { row, quality, rounds, decision } — the pass recorded, the loop's next step, and what to do about the merge. */
export function reviewNext(workdir, review, opts = {}) {
  const { row, quality } = recordReview(workdir, review, { repo: opts.repo || '' });
  const pr = readJson(join(workdir, `${opts.repo ? `pr.${opts.repo}` : 'pr'}.json`), []) || {};
  const history = (pr.reviews || []).map((r) => ({ round: r.round, sha: r.sha, verdict: r.verdict, open: r.open, new: r.new }));
  const loop = rounds({ rating: opts.rating, files: opts.files || 0, lines: opts.lines || 0, history, claudeDir: opts.claudeDir });
  const decision = mergeDecision({ next: NEXT[loop.next] || 'fix', open: quality.open, verdict: row.verdict, mergeable: opts.mergeable ?? null, checks: opts.checks || null, merge: opts.merge || null, standing: opts.standing || null, why: loop.why });
  return { row, quality, rounds: loop, decision };
}
