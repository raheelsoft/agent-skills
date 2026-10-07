// util.mjs — what every part of the day planner shares: the stages' order, the state script's path, the clock and small helpers.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'state.mjs');

export const ORDER = ['start-ticket', 'triage', 'plan', 'plan-check', 'implement', 'create-pr', 'merge', 'release', 'accept'];

export const RATINGS = ['low', 'medium', 'high'];

export const nowIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const today = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const uniq = (list) => [...new Set(list)];

export const fail = (msg) => { throw new Error(msg); };

export const stageIndex = (next) => { if (!next) return ORDER.length; const i = ORDER.indexOf(String(next).split(':')[0]); return i < 0 ? ORDER.length : i; };

export const idKey = (id) => { const m = /^(.*?)(\d+)$/.exec(id); return m ? [m[1], Number(m[2])] : [id, 0]; };

export const byId = (a, b) => { const [pa, na] = idKey(a), [pb, nb] = idKey(b); return pa < pb ? -1 : pa > pb ? 1 : na - nb; };
