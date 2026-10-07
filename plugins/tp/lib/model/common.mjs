// common.mjs — what every part of the model script shares: the ratings, reading tiers.json, the atomic JSON write and the clock.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';


export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

export const RATINGS = ['low', 'medium', 'high'];

export function readTiers(task) {
  if (task.tiers && typeof task.tiers === 'object') return task.tiers;
  const file = task.claudeDir ? join(task.claudeDir, 'tiers.json') : null;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export const at = (r) => RATINGS.indexOf(r);

export const higherOf = (a, b) => (at(a) >= at(b) ? a : b);

// The person's answer to "what is the largest model this pipeline may use?" (/tp:setup): `ladder` is the runtime's models,
// smallest first, as its spawn argument names them; `ceiling` is one of them. Nothing here names a model — both are data.
