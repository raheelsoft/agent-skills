// index.mjs — the contract library's public API: what a hook, a test or state/put.mjs imports instead of spawning validate.mjs.
export { validate, unsupportedKeywords, SUPPORTED, ANNOTATIONS } from './schema.mjs';
export { ARTIFACTS, SCHEMA_DIR, SCHEMA_VERSION, loadSchema, artifactOf, checkArtifact, checkWorkdir, checkWorkroot } from './registry.mjs';
export { invariants } from './invariants.mjs';
export { PRIORITIES, TIERS, tierOf, verdictOf, idsOf, rowOf, renderReview } from './findings.mjs';
export { PRIORITY_KEYS, WEIGHTS, scoreOf, compareOpen, aggregate } from './quality.mjs';
export { parsePlan, lintPlan, lintWorkdir } from './plan.mjs';
export { shapeOf, catalogue } from './shape.mjs';
export { checksOf, lintChecks } from './proof.mjs';
