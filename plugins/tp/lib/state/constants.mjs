// constants.mjs — the vocabulary of the work directory: the events a progress row may carry, the stage order, which stages run per repo, how long a lock or an
// agent record lives, the kinds of stop, the office's levels and name pools. Values only — nothing here reads a file.

export const EVENTS = new Set(['started', 'done', 'stopped', 'note']);

export const ORDER = ['start-ticket', 'triage', 'plan', 'plan-check', 'implement', 'create-pr', 'merge', 'release', 'accept'];

export const PER_REPO = new Set(['implement', 'create-pr', 'merge', 'release']);

export const EXTRA_STAGES = new Set(['run-ticket', 'retro']); // logged, never part of the expected sequence

export const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // a lock nobody refreshed for 6 h belongs to a dead run

export const SEP = ' · ';

export const STOP_KINDS = ['question', 'approval', 'error', 'usage', 'blocked', 'problem'];

export const LEVELS = ['manager', 'lead', 'engineer', 'qa', 'reviewer'];

export const POOLS = { manager: 'managers', lead: 'leads', engineer: 'engineers', qa: 'qa', reviewer: 'reviewers' };

export const DEFAULT_NAMES = { // neutral pools; office.json overrides them
  managers: ['Morgan', 'Avery', 'Jordan', 'Riley'],
  leads: ['Sam', 'Casey', 'Quinn', 'Harper', 'Rowan', 'Reese', 'Emerson', 'Blake'],
  engineers: ['Alex', 'Jamie', 'Taylor', 'Drew', 'Kai', 'Noor', 'Remy', 'Sage', 'Ari', 'Lee', 'Nico', 'Sky'],
  qa: ['Robin', 'Devon', 'Shay', 'Finley', 'Marlow', 'Indigo'],
  reviewers: ['Dana', 'Eden', 'Parker', 'Jules'],
};

export const AGENT_LEFT_KEEP_MS = 60 * 60 * 1000;       // a departed agent's record lives an hour

export const AGENT_STALE_MS = 24 * 60 * 60 * 1000;      // an agent nobody refreshed for a day is forgotten

export const RATING_VALUES = ['low', 'medium', 'high'];

export const LEAVE_STATUSES = { done: 'done', stopped: 'stopped', gone: 'gone', error: 'gone' };
