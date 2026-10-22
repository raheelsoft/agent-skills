// agents.mjs — the office's agents: who joins, who leaves, their stable names from the pools in office.json, and the pruning of records nobody refreshed
// (reference/observability.md § Observability).
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, dirname, resolve } from 'node:path';
import { AGENT_LEFT_KEEP_MS, AGENT_STALE_MS, DEFAULT_NAMES, LEAVE_STATUSES, LEVELS, POOLS, RATING_VALUES } from './constants.mjs';
import { CliError, isDir, nowIso, readJson } from './util.mjs';

export function officeConfig(workroot) {
  const file = join(dirname(resolve(workroot)), 'office.json'); // <.claude>/office.json next to work/
  const cfg = readJson(file, []) || {};
  const names = { ...DEFAULT_NAMES };
  for (const [k, v] of Object.entries(cfg.names || {})) if (Array.isArray(v) && v.length) names[k] = v.map(String);
  return {
    team: typeof cfg.team === 'string' && cfg.team ? cfg.team : basename(dirname(resolve(workroot))),
    projects: Array.isArray(cfg.projects) ? cfg.projects.map(String) : [],
    poll: Number(cfg.poll) > 0 ? Number(cfg.poll) : 2500,
    linger: Number(cfg.linger) >= 0 ? Number(cfg.linger) : 120,
    names,
  };
}

export const agentsDir = (workroot) => join(workroot, '_office', 'agents');

export const agentFile = (workroot, id) => join(agentsDir(workroot), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}.json`);

export function readAgents(workroot) {
  const dir = agentsDir(workroot);
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f), [])).filter((a) => a && a.id);
}

export function writeAgent(workroot, record) {
  mkdirSync(agentsDir(workroot), { recursive: true });
  const file = agentFile(workroot, record.id);
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n');
  renameSync(`${file}.tmp`, file); // atomic: parallel joins never see a half-written file
}

export function pruneAgents(workroot, now = Date.now()) {
  for (const a of readAgents(workroot)) {
    const leftAt = a.left?.at ? Date.parse(a.left.at) : null;
    const updated = Date.parse(a.updated || a.started || 0);
    if ((leftAt && now - leftAt > AGENT_LEFT_KEEP_MS) || (!leftAt && now - updated > AGENT_STALE_MS)) {
      try { unlinkSync(agentFile(workroot, a.id)); } catch { /* already gone */ }
    }
  }
}

// a stable name: the pool entry the id hashes to, probing past names live agents of the same level hold
export function assignName(workroot, record, cfg) {
  const pool = cfg.names[POOLS[record.level]];
  const taken = new Set(readAgents(workroot).filter((a) => a.id !== record.id && a.level === record.level && !a.left).map((a) => a.name));
  const start = parseInt(createHash('sha1').update(record.id).digest('hex').slice(0, 8), 16) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const name = pool[(start + i) % pool.length];
    if (!taken.has(name)) return name;
  }
  return `${pool[start]} 2`;
}

export function agentJoin(workroot, payload) {
  const usageLine = 'usage: agent join <workroot> \'{ "id", "level", "stage", "role"?, "ticket"?, "repo"?, "parent"?, "rating"? }\'';
  const refuse = (why) => { throw new CliError(`${usageLine}\n${why}`, 2); };
  if (!workroot) { throw new CliError(usageLine, 2); }
  // Everything is checked before anything is written: a refused call leaves no trace — no work root named after the JSON it was
  // handed in the wrong place, no folder called after a flag.
  if (/^[{[]/.test(workroot)) refuse('the first argument is the work root, not the JSON — the payload is the second argument');
  if (workroot.startsWith('-')) refuse(`the first argument is the work root, not an option ("${workroot}") — the id goes inside the JSON payload`);
  if (payload == null || payload === '') refuse('the second argument is the JSON payload, after the work root');
  let p;
  try { p = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { refuse(`${e.message}\nthe second argument must be the JSON payload, after the work root`); }
  if (!p || typeof p.id !== 'string' || !/^\S+$/.test(p.id)) refuse('id must be a non-empty string without spaces');
  if (!LEVELS.includes(p.level)) refuse(`level must be one of ${LEVELS.join(', ')}`);
  if (typeof p.stage !== 'string' || !p.stage) refuse('stage is required');
  const cfg = officeConfig(workroot);
  pruneAgents(workroot);
  const prev = readAgents(workroot).find((a) => a.id === p.id);
  const now = nowIso();
  const record = {
    id: p.id,
    name: prev?.name || assignName(workroot, p, cfg),
    level: p.level,
    role: typeof p.role === 'string' && p.role ? p.role : p.level,
    ticket: typeof p.ticket === 'string' && p.ticket ? p.ticket : null,
    stage: p.stage,
    repo: typeof p.repo === 'string' && p.repo ? p.repo : null,
    parent: typeof p.parent === 'string' && p.parent ? p.parent : null,
    rating: RATING_VALUES.includes(p.rating) ? p.rating : null,
    started: prev?.started || now,
    updated: now,
    left: null,
  };
  writeAgent(workroot, record); // creates <workroot>/_office/agents, and the work root with it: a fresh install's first agent joins before any ticket exists
  return record;
}

export function agentLeave(workroot, id, status = 'done') {
  if (!isDir(workroot) || !id) { throw new CliError('usage: agent leave <workroot> <id> [done|stopped|gone]', 2); }
  const prev = readAgents(workroot).find((a) => a.id === id);
  if (!prev) return { id, left: null, note: 'unknown agent' };
  const record = { ...prev, updated: nowIso(), left: { at: nowIso(), status: LEAVE_STATUSES[status] || 'done' } };
  writeAgent(workroot, record);
  return record;
}
