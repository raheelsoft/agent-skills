// route.mjs — what /tp:run-ticket does first with a ticket, decided by the script from the state and not argued out by a model: no work directory yet,
// a round above the ticket's, nothing left to do, an unreadable record, a stop that is answered, an answer waiting in the office's queue, a usage pause
// whose reset passed, a parked ticket whose blockers landed, or simply the next stage. The orchestrator acts on `action` and never reads the state to work
// the same thing out (skills/run-ticket/SKILL.md step 0).
import { basename, dirname, join } from 'node:path';
import { CliError, isDir, readJson } from './util.mjs';
import { computeState } from './compute.mjs';
import { answerTake } from './inbox.mjs';

/**
 * -> { action: 'first-run' | 'restart' | 'rerun' | 'run' | 'stop' | 'refuse' | 'error' | 'locked', why, next?, answers?, from?, stop?, needs?, owner?, note?, startTicketForce? }
 *   first-run  no work directory: /tp:start-ticket, answers passed through
 *   restart    round= above ticket.json.round: /tp:start-ticket regardless of the state
 *   refuse     done or closed, and neither round= nor force=true: say so, no lock, nothing logged
 *   rerun      force=true on a done or closed ticket
 *   error      the record has problems: the report, `needs` the fix
 *   stop       stopped and nobody answered: the stop is the report
 *   run        take the lock and run `next` (`answers` when this run has one; `startTicketForce` when parked repos must be re-created first)
 *   locked     a live lock held by another owner: that is the stop, without unlocking
 */
export function routeRun(workroot, id, { round = null, force = false, answers = null, owner = null, now = Date.now() } = {}) {
  const wd = join(workroot, id);
  if (!isDir(wd)) return { action: 'first-run', why: 'no work directory for this ticket yet' };
  const st = computeState(wd);
  const ticket = readJson(join(wd, 'ticket.json'), []) || {};
  const ticketRound = Number(ticket.round) || 1;
  if (round && Number(round) > ticketRound) return { action: 'restart', why: `round=${round} is above ticket.json.round (${ticketRound}): the earlier stages re-run as stale` };

  if (!st.stopped && (st.closed || st.next === null)) {
    if (!force) return { action: 'refuse', why: `already ${st.closed ? 'closed' : 'done'}; round=${ticketRound + 1} or force=true to re-run` };
    return { action: 'rerun', why: 'force=true on a finished ticket' };
  }
  if (st.problems?.length) return { action: 'error', why: 'the ticket record has problems', needs: st.problems };

  let decided;
  if (st.stopped) {
    if (answers) decided = { action: 'run', answers, from: 'caller', next: st.next };
    else {
      try {
        const a = answerTake(workroot, id, '--consume');
        decided = { action: 'run', answers: a.answer, from: 'office', next: st.next };
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        if (e.code === 3) return { action: 'stop', stop: st.stopped, note: 'a queued answer no longer matched this stop and was set aside', why: 'stopped' };
        const s = st.stopped;
        const usagePast = s.kind === 'usage' && s.resetAt && Date.parse(s.resetAt) <= now;
        const unblocked = s.kind === 'blocked' && st.unblocked;
        if (!usagePast && !unblocked) return { action: 'stop', stop: s, why: 'stopped, and no answer was given' };
        const discarded = (ticket.repos || []).some((r) => r && r.discarded);
        decided = { action: 'run', why: usagePast ? 'the usage pause has passed its reset' : 'every blocker has landed', next: st.next, ...(discarded ? { startTicketForce: true } : {}) };
      }
    }
  } else decided = { action: 'run', next: st.next };

  if (st.lock && !st.lock.stale && owner && st.lock.owner !== owner) return { action: 'locked', owner: st.lock.owner, why: `a live run holds the lock since ${st.lock.since}` };
  return decided;
}

/** `state.mjs route <workdir|id> [--round n] [--force] [--answers text] [--owner o]`: the flags as options, the ticket named by its work directory. */
export function routeWorkdir(workdir, o = {}) {
  return routeRun(dirname(workdir), basename(workdir), { round: o.round ? Number(o.round) : null, force: o.force === true, answers: typeof o.answers === 'string' ? o.answers : null, owner: typeof o.owner === 'string' ? o.owner : null });
}
