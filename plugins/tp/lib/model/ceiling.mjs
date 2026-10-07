// ceiling.mjs — the largest model the pipeline may use. The person's answer to "what is the largest model this pipeline may use?" (/tp:setup):
// `ladder` is the runtime's models, smallest first, as its spawn argument names them; `ceiling` is one of them. Nothing here names a model — both are data.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RATINGS, readTiers, writeAtomic } from './common.mjs';

export const ladderOf = (tiers) => (Array.isArray(tiers.ladder) ? tiers.ladder.map((m) => String(m).trim()).filter(Boolean) : []);

export const ceilingIdx = (tiers) => (typeof tiers.ceiling === 'string' ? ladderOf(tiers).indexOf(tiers.ceiling) : -1);

/** The three tiers a ceiling gives: low is the smallest model, high the ceiling, medium the first step up from the smallest —
 *  so a ceiling of one model puts it on every tier, and one of two puts the larger on medium and high (the rating still sets the
 *  effort, the review rounds, the retries and the estimate). `allowed` is every model up to and including the ceiling. */

export function tiersFor(ladder, ceiling) {
  const list = (Array.isArray(ladder) ? ladder : []).map((m) => String(m).trim()).filter(Boolean);
  if (!list.length) throw new Error('no ladder: name the runtime\'s models, smallest first — ladder=<smallest>,…,<largest>');
  if (new Set(list).size !== list.length) throw new Error(`the ladder names a model twice: ${list.join(', ')}`);
  const top = list.indexOf(String(ceiling));
  if (top < 0) throw new Error(`the ceiling "${ceiling}" is not on the ladder (${list.join(' < ')})`);
  const allowed = list.slice(0, top + 1);
  return { allowed, tiers: { low: allowed[0], medium: allowed[Math.min(1, top)], high: allowed[top] } };
}

/** A model above the ceiling runs on the ceiling instead; one that is not on the ladder cannot be compared and passes (the doctor says so). */

export function withinCeiling(model, tiers = {}) {
  const top = ceilingIdx(tiers);
  const i = ladderOf(tiers).indexOf(String(model));
  return top >= 0 && i > top ? { model: ladderOf(tiers)[top], clamped: true } : { model, clamped: false };
}

/** Where a model the runtime names sits against the ceiling — the ladder entry its name contains ("claude-<entry>-5" → <entry>; the longest entry wins). */

export function standing(name, list, top) {
  const lower = String(name || '').toLowerCase();
  let hit = -1;
  list.forEach((m, i) => { if (lower.includes(m.toLowerCase()) && (hit < 0 || m.length > list[hit].length)) hit = i; });
  return { model: String(name), rung: hit >= 0 ? list[hit] : null, within: hit < 0 || top < 0 ? null : hit <= top };
}

/** The model the project's settings start a session on (`model`; settings.local.json over settings.json), or null. */

export function startupModel(claudeDir) {
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const j = JSON.parse(readFileSync(join(claudeDir, name), 'utf8'));
      if (typeof j.model === 'string' && j.model) return { file: name, model: j.model };
    } catch { /* absent or not JSON: the next one */ }
  }
  return null;
}

/**
 * What the pipeline may use, and whether the files agree with it: the ceiling, the ladder, every model up to the ceiling, the
 * three tiers, what is inconsistent (`problems`), and where the project's starting model (`startup`) and a model the caller
 * names (`session` — the one its own context runs on) sit against the ceiling: `within` is true, false, or null when the name is
 * not on the ladder and cannot be compared.
 */

export function ceilingStatus(input = {}) {
  const tiers = readTiers(input);
  const ladder = ladderOf(tiers);
  const top = ceilingIdx(tiers);
  const ceiling = typeof tiers.ceiling === 'string' && tiers.ceiling ? tiers.ceiling : null;
  const mapped = Object.fromEntries(RATINGS.map((r) => [r, typeof tiers[r] === 'string' && tiers[r] ? tiers[r] : null]));
  const problems = [];
  if (!ceiling) problems.push('no ceiling is set: every model the tiers name is allowed');
  else if (!ladder.length) problems.push(`the ceiling ${ceiling} has no ladder to be checked against`);
  else if (top < 0) problems.push(`the ceiling ${ceiling} is not on the ladder (${ladder.join(' < ')})`);
  else {
    for (const r of RATINGS) {
      if (!mapped[r]) continue;
      const i = ladder.indexOf(mapped[r]);
      if (i < 0) problems.push(`${r}=${mapped[r]} is not on the ladder, so the ceiling cannot be checked for it`);
      else if (i > top) problems.push(`${r}=${mapped[r]} is above the ceiling ${ceiling}: it runs on ${ceiling}`);
    }
  }
  const where = (name) => (top >= 0 ? standing(name, ladder, top) : { model: String(name), rung: null, within: null });
  const startup = input.claudeDir ? startupModel(input.claudeDir) : null;
  return {
    ceiling, ladder, allowed: top >= 0 ? ladder.slice(0, top + 1) : null, tiers: mapped, problems,
    startup: startup ? { ...startup, ...where(startup.model) } : null,
    session: input.session ? where(input.session) : null,
  };
}

/** The ceiling as the runtime's `model` setting for this project — the model a session starts on. Written only when the setting is unset,
 *  above the ceiling or not comparable; one already within the ceiling is the person's choice and stays. It is an initial selection, not a cap. */

export function pinSession(claudeDir) {
  const st = ceilingStatus({ claudeDir });
  if (!st.allowed) throw new Error(`nothing to pin: ${st.problems[0]} — set it first: node model.mjs tiers ${claudeDir} ceiling=<model> ladder=<smallest>,…,<largest>`);
  const file = join(claudeDir, 'settings.local.json');
  let prev = {};
  if (existsSync(file)) { try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON — fix it first; nothing was changed`); } }
  const was = typeof prev.model === 'string' && prev.model ? prev.model : null;
  if (was && standing(was, st.ladder, st.ladder.indexOf(st.ceiling)).within === true) return { file, model: was, was, written: false };
  writeAtomic(file, { ...prev, model: st.ceiling });
  return { file, model: st.ceiling, was, written: true };
}

/** A count a caller may have written either as the number or as the list itself (a plan's `steps`, a diff's `files`,
 *  a ticket's `criteria`): the list's length, else the number, else 0. An array must never reach a `>=` below — it
 *  coerces to NaN there and silently fails every threshold, under-rating the work. */
