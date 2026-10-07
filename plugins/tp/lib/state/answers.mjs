// answers.mjs — the answers queued for a stop, in `_inbox/`: the file naming and the read of one pending answer. The writing side is inbox.mjs.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson } from './util.mjs';

export const inboxDir = (workroot) => join(workroot, '_inbox');

export const safeName = (id) => `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}`;

export const inboxFile = (workroot, id) => join(inboxDir(workroot), `${safeName(id)}.json`);

// the answer queued for `id`, or null
export function pendingAnswer(workroot, id) {
  const f = inboxFile(workroot, id);
  const a = existsSync(f) ? readJson(f, []) : null;
  return a && a.id === id && typeof a.answer === 'string' ? a : null;
}
