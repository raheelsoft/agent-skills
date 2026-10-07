#!/usr/bin/env node
// tracker.mjs — a file-backed tracker (skills/README.md § Definitions, Tracker): the same reads and writes the skills
// make against a real tracker, over one JSON file, so the pipeline can be exercised end to end without a tracker
// account (§ Using it, Simulation). Selected by <.claude>/tracker.json: { "kind": "fixture", "path": "/abs/tracker.json" };
// without that file the skills use the connected tracker tool and this script is never called.
//
//   node tracker.mjs get <id>                                   -> the ticket, with its blockers' current states
//   node tracker.mjs list [--state s] [--label l] [--iteration i] [--assignee a] [--parent p] [--open]
//                                                               -> tickets matching every filter given (--open: not done/cancelled)
//   node tracker.mjs save <id> '<patch json>'                   -> patch state, assignee, estimate, labels, blockedBy, parent,
//                                                                  priority, title, description; history keeps every patch
//   node tracker.mjs comment <id> '<text>'                      -> append a comment
//   node tracker.mjs create '<ticket json>'                     -> a new ticket (id from the team prefix and the next number)
//   node tracker.mjs iterations | labels | states | me          -> the fixture's iterations (name, start, end), labels, states, the person
//   --file <path> or --claude <.claude> select the fixture explicitly (default: <.claude>/tracker.json next to this skills/ folder)
//
// Fixture shape: { project, team, me, states: [...], iterations: [{ name, start, end }], labels: [{ name, description? }],
//                  tickets: [{ id, title, description, state, assignee, labels, parent, priority, estimate, blockedBy, iteration,
//                              comments: [{ at, text }], history: [{ at, patch }], createdAt, updatedAt }] }
// No dependencies.

import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const PATCHABLE = ['title', 'description', 'state', 'assignee', 'estimate', 'labels', 'blockedBy', 'parent', 'priority', 'iteration'];
const DONE = new Set(['done', 'canceled', 'cancelled', 'duplicate', 'closed']);

function flags(list) {
  const o = { _: [] };
  for (let i = 0; i < list.length; i++) {
    if (String(list[i]).startsWith('--')) o[list[i].slice(2)] = list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[++i] : true;
    else o._.push(list[i]);
  }
  return o;
}

export function fixturePath(opts = {}) {
  if (opts.file) return resolve(opts.file);
  const claudeDir = opts.claude ? resolve(opts.claude) : resolve(HERE, '..', '..');
  const cfg = join(claudeDir, 'tracker.json');
  if (!existsSync(cfg)) throw new Error(`${cfg} missing — this install uses the connected tracker tool, not a fixture`);
  let c; try { c = JSON.parse(readFileSync(cfg, 'utf8')); } catch (e) { throw new Error(`${cfg} is not valid JSON: ${e.message}`); }
  if (c.kind !== 'fixture' || typeof c.path !== 'string') throw new Error(`${cfg} must be { "kind": "fixture", "path": "<abs path>" }`);
  return resolve(claudeDir, c.path);
}

export function load(file) {
  if (!existsSync(file)) throw new Error(`fixture ${file} missing`);
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(f.tickets)) throw new Error(`fixture ${file}: "tickets" must be an array`);
  return f;
}
function store(file, f) {
  writeFileSync(`${file}.tmp`, JSON.stringify(f, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}
const find = (f, id) => { const t = f.tickets.find((x) => x.id === id); if (!t) throw new Error(`no ticket ${id} in the fixture`); return t; };
const isDone = (t) => DONE.has(String(t.state || '').toLowerCase());

// a ticket as a skill reads it: its blockers carry their current state, its children are listed
export function get(f, id) {
  const t = find(f, id);
  return {
    ...t, link: `fixture://${t.id}`,
    blockedBy: (t.blockedBy || []).map((b) => { const x = f.tickets.find((y) => y.id === b); return { id: b, state: x ? x.state : null, title: x ? x.title : null }; }),
    children: f.tickets.filter((x) => x.parent === t.id).map((x) => ({ id: x.id, title: x.title, state: x.state })),
  };
}

export function list(f, q = {}) {
  const has = (v) => v != null && v !== true && v !== '';
  return f.tickets.filter((t) => (!has(q.state) || String(t.state).toLowerCase() === String(q.state).toLowerCase())
    && (!has(q.label) || (t.labels || []).some((l) => l.toLowerCase() === String(q.label).toLowerCase()))
    && (!has(q.iteration) || String(t.iteration || '').toLowerCase() === String(q.iteration).toLowerCase())
    && (!has(q.assignee) || String(t.assignee || '').toLowerCase() === String(q.assignee).toLowerCase())
    && (!has(q.parent) || t.parent === q.parent)
    && (!q.open || !isDone(t)))
    .map((t) => ({ id: t.id, title: t.title, state: t.state, assignee: t.assignee ?? null, labels: t.labels || [], parent: t.parent ?? null, priority: t.priority ?? null, estimate: t.estimate ?? null, blockedBy: t.blockedBy || [], iteration: t.iteration ?? null, link: `fixture://${t.id}` }));
}

export function save(file, f, id, patch) {
  const t = find(f, id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('the patch must be a JSON object');
  const bad = Object.keys(patch).filter((k) => !PATCHABLE.includes(k));
  if (bad.length) throw new Error(`cannot patch ${bad.join(', ')} (allowed: ${PATCHABLE.join(', ')})`);
  if ('state' in patch && Array.isArray(f.states) && !f.states.some((s) => s.toLowerCase() === String(patch.state).toLowerCase())) throw new Error(`unknown state "${patch.state}" (states: ${f.states.join(', ')})`);
  if ('blockedBy' in patch && (!Array.isArray(patch.blockedBy) || patch.blockedBy.some((b) => typeof b !== 'string'))) throw new Error('blockedBy must be an array of ids');
  if ('labels' in patch && (!Array.isArray(patch.labels) || patch.labels.some((b) => typeof b !== 'string'))) throw new Error('labels must be an array of names');
  if ('estimate' in patch && patch.estimate != null && !(Number(patch.estimate) >= 0)) throw new Error('estimate must be a number');
  if (patch.assignee === 'me') patch.assignee = f.me || 'me';
  if ('state' in patch) patch.state = f.states.find((s) => s.toLowerCase() === String(patch.state).toLowerCase());
  Object.assign(t, patch, { updatedAt: nowIso() });
  t.history = (t.history || []).concat([{ at: t.updatedAt, patch }]);
  store(file, f);
  return get(f, id);
}

export function comment(file, f, id, text) {
  const t = find(f, id);
  if (typeof text !== 'string' || !text.trim()) throw new Error('a comment needs text');
  t.comments = (t.comments || []).concat([{ at: nowIso(), text: text.trim() }]);
  t.updatedAt = nowIso();
  store(file, f);
  return { id, comments: t.comments.length, link: `fixture://${id}#comment-${t.comments.length}` };
}

export function create(file, f, input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('a ticket needs a title');
  const prefix = f.team || 'T';
  const n = f.tickets.reduce((m, t) => { const x = /-(\d+)$/.exec(t.id); return x ? Math.max(m, Number(x[1])) : m; }, 0) + 1;
  const t = { id: `${prefix}-${n}`, title: input.title.trim(), description: input.description || '', state: input.state && f.states.includes(input.state) ? input.state : (f.states?.[0] || 'Backlog'), assignee: input.assignee ?? null, labels: Array.isArray(input.labels) ? input.labels : [], parent: input.parent ?? null, priority: input.priority ?? null, estimate: input.estimate ?? null, blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy : [], iteration: input.iteration ?? null, comments: [], history: [], createdAt: nowIso(), updatedAt: nowIso() };
  f.tickets.push(t);
  store(file, f);
  return get(f, t.id);
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, ...rest] = process.argv;
  const o = flags(rest);
  try {
    const file = fixturePath(o);
    const f = load(file);
    switch (cmd) {
      case 'get': { if (!o._[0]) throw new Error('usage: get <id>'); emit(get(f, o._[0])); break; }
      case 'list': emit(list(f, o)); break;
      case 'save': { if (!o._[0] || !o._[1]) throw new Error('usage: save <id> \'<patch>\''); emit(save(file, f, o._[0], JSON.parse(o._[1]))); break; }
      case 'comment': { if (!o._[0] || !o._[1]) throw new Error('usage: comment <id> \'<text>\''); emit(comment(file, f, o._[0], o._[1])); break; }
      case 'create': { if (!o._[0]) throw new Error('usage: create \'<ticket json>\''); emit(create(file, f, JSON.parse(o._[0]))); break; }
      case 'iterations': emit(Array.isArray(f.iterations) ? f.iterations : []); break;
      case 'labels': emit(Array.isArray(f.labels) ? f.labels : []); break;
      case 'states': emit(Array.isArray(f.states) ? f.states : []); break;
      case 'me': emit({ me: f.me || 'me', project: f.project || null, team: f.team || null }); break;
      default: console.error('usage: tracker.mjs get|list|save|comment|create|iterations|labels|states|me … [--file <fixture>] [--claude <.claude>]'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
}
