// rating.mjs — numeric evidence to a rating, low | medium | high (reference/models-and-budget.md § Models and budget, Rating).

export const DEFAULT_THRESHOLDS = { medium: 2, high: 4 }; // score → rating

export const countOf = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);

export const SIGNALS = ['flags', 'steps', 'files', 'lines', 'repos', 'criteria', 'round', 'retries'];

export const signalsOf = (s) => Object.fromEntries(SIGNALS.map((k) => [k, countOf(s[k])]));

/** Numeric evidence → rating. The rubric's own judgment wins where it is higher. */

export function rate(s = {}, thresholds = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const why = [];
  let n = 0;
  const { flags, steps, files, lines, repos, criteria, round, retries } = signalsOf(s);
  const failedAttempt = round > 1 || retries >= 1;
  if (flags) { n += Math.min(3, flags); why.push(`${flags} risk flag(s)`); }
  if (steps >= 6) { n += 2; why.push(`${steps} steps`); } else if (steps >= 3) { n += 1; why.push(`${steps} steps`); }
  if (files >= 15) { n += 2; why.push(`${files} files`); } else if (files >= 5) { n += 1; why.push(`${files} files`); }
  if (lines >= 500) { n += 2; why.push(`${lines} lines`); } else if (lines >= 150) { n += 1; why.push(`${lines} lines`); }
  if (repos > 1) { n += 1; why.push(`${repos} repos`); }
  if (criteria >= 5) { n += 1; why.push(`${criteria} criteria`); }
  if (s.unclear) { n += 1; why.push('unclear'); }
  if (failedAttempt) { n += 2; why.push('after a failed attempt'); }
  let rating = n >= th.high ? 'high' : n >= th.medium ? 'medium' : 'low';
  if (s.mechanical && !failedAttempt) { rating = 'low'; why.push('mechanical: verifiable output'); }
  return { rating, score: n, why: why.join(', ') || 'no signals' };
}
