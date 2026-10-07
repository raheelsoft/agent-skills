// index.mjs — the model script's public API: what a hook, a test or another script imports instead of spawning model.mjs.
export { RATINGS, higherOf } from './common.mjs';
export { tiersFor, withinCeiling, ceilingStatus, pinSession } from './ceiling.mjs';
export { rate } from './rating.mjs';
export { budget, pick } from './budget.mjs';
export { rounds, compact, retry } from './loops.mjs';
export { DEFAULT_DAY, dayConfig, estimate } from './estimate.mjs';
export { calibrate } from './calibrate.mjs';
export { writeTiers } from './tiers.mjs';
