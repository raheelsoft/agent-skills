// tiers.mjs — the one writer of a model name: tiers.json from `ceiling=` / `ladder=` / `low=` `medium=` `high=` (README § Models and budget, The ceiling).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RATINGS } from './common.mjs';
import { ladderOf, tiersFor } from './ceiling.mjs';

export function writeTiers(claudeDir, pairs) {
  const given = {};
  for (const p of pairs) {
    const m = /^(ceiling|ladder|low|medium|high)=(.+)$/.exec(p);
    if (!m) throw new Error(`bad tier "${p}" — use ceiling=<model> [ladder=<smallest>,…,<largest>], or low=<model> medium=<model> high=<model>`);
    given[m[1]] = m[2].trim();
  }
  if (!existsSync(claudeDir)) throw new Error(`${claudeDir} does not exist`);
  if (given.ladder && !given.ceiling) throw new Error('ladder= goes with ceiling=<model>: name the largest model the pipeline may use');
  const file = join(claudeDir, 'tiers.json');
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let ceiling = typeof prev.ceiling === 'string' && prev.ceiling ? prev.ceiling : null;
  let ladder = ladderOf(prev);
  const tiers = {};
  if (given.ceiling) {
    ceiling = given.ceiling;
    if (given.ladder) ladder = given.ladder.split(',').map((m) => m.trim()).filter(Boolean);
    Object.assign(tiers, tiersFor(ladder, ceiling).tiers);
  }
  for (const r of RATINGS) if (given[r]) tiers[r] = given[r];
  for (const r of RATINGS) if (!tiers[r]) throw new Error(`missing ${r}=<model>`);
  if (ceiling) {
    const top = ladder.indexOf(ceiling);
    if (top < 0) throw new Error(`the ceiling "${ceiling}" is not on the ladder (${ladder.join(' < ') || 'none recorded'}) — pass ceiling= with ladder=`);
    for (const r of RATINGS) {
      const i = ladder.indexOf(tiers[r]);
      if (i < 0) throw new Error(`${r}=${tiers[r]} is not on the ladder (${ladder.join(' < ')}) — name a model from it, or extend the ladder: ceiling=${ceiling} ladder=…`);
      if (i > top) throw new Error(`${r}=${tiers[r]} is above the ceiling ${ceiling} (the pipeline may use ${ladder.slice(0, top + 1).join(', ')}) — raise the ceiling first: ceiling=${tiers[r]}`);
    }
  }
  const { ceiling: _c, ladder: _l, low: _lo, medium: _me, high: _hi, ...rest } = prev;
  const out = { ...(ceiling ? { ceiling, ladder } : {}), ...tiers, ...rest };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out;
}
