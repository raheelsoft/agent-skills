// index.mjs — the git-hooks script's public API: what codegen.mjs, the doctor and the tests import instead of spawning hooks.mjs.
export { GATES } from './common.mjs';
export { runnersOf } from './runners.mjs';
export { gatesOf } from './gates.mjs';
export { lintStagedConfig, preCommitConfig, detect, cover } from './detect.mjs';
export { planHooks, install } from './install.mjs';
