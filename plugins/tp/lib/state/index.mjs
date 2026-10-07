// index.mjs — the state library's public API: what a hook, a test or another script imports instead of spawning state.mjs. Every function here
// reads or writes the work directory and returns data; none prints or exits — a refusal is a CliError (util.mjs) the caller catches.
export { CliError } from './util.mjs';
export { log, parseProgress } from './progress.mjs';
export { lockRun, unlockRun, readLock } from './lock.mjs';
export { computeState, brief, durations, rowOf, ticketDirs, all, totals } from './compute.mjs';
export { usage } from './usage.mjs';
export { pendingAnswer } from './answers.mjs';
export { inbox, answerQueue, answerTake } from './inbox.mjs';
export { recordBlockers, recordActual } from './records.mjs';
export { putArtifact, payloadText } from './put.mjs';
export { agentJoin, agentLeave, readAgents } from './agents.mjs';
export { office } from './office.mjs';
