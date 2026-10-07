// lock.mjs — the run lock: one run at a time per ticket. A lock nobody refreshed for six hours belongs to a dead run and is never revived by a note.
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_STALE_MS } from './constants.mjs';
import { CliError, isDir, nowStamp, readJson } from './util.mjs';

export function readLock(workdir) {
  const lock = readJson(join(workdir, 'lock.json'), []);
  if (!lock?.owner) return null;
  const stale = Date.now() - Date.parse(lock.updated || lock.since || 0) > LOCK_STALE_MS;
  return { ...lock, stale };
}

export function lockRun(workdir, owner) {
  if (!isDir(workdir) || !owner) { throw new CliError('usage: lock <workdir> <owner>', 2); }
  const cur = readLock(workdir);
  if (cur && cur.owner !== owner && !cur.stale) {
    throw new CliError(`locked by ${cur.owner} since ${cur.since} (last activity ${cur.updated})`, 3);
  }
  const now = nowStamp();
  writeFileSync(join(workdir, 'lock.json'), JSON.stringify({ owner, since: cur?.owner === owner ? cur.since : now, updated: now }, null, 2) + '\n');
  return `locked by ${owner}\n`;
}

export function unlockRun(workdir, owner, force) {
  const file = join(workdir, 'lock.json');
  const cur = readLock(workdir);
  if (!cur) return 'no lock to release\n';
  if (cur.owner !== owner && !force && !cur.stale) { throw new CliError(`locked by ${cur.owner}; pass --force to release it`, 3); }
  unlinkSync(file);
  return `unlocked (${cur.owner})\n`;
}

// any progress refreshes a live lock; a stale one belongs to a dead run and is never revived by a note
export function touchLock(workdir) {
  const cur = readLock(workdir);
  if (cur && !cur.stale) writeFileSync(join(workdir, 'lock.json'), JSON.stringify({ owner: cur.owner, since: cur.since, updated: nowStamp() }, null, 2) + '\n');
}
