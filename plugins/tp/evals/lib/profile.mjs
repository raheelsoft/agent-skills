#!/usr/bin/env node
// profile.mjs — where one eval run's model turns went, so the mechanical ones can be moved to a script (evals/README.md § Reading a run).
// Input: the trace of a run kept with `claude plugin eval --keep-temp` — the kept folder (…/e-XXXXXX) or its out/trace.jsonl. A turn is one
// assistant message; it is *mechanical* when everything it did was plumbing a script could do from files and command output alone — the state
// and tracker scripts, git, shell reads and moves — and it said next to nothing. The report lists those turns' commands, grouped by shape.
//
//   node evals/lib/profile.mjs <kept folder | trace.jsonl> […]   [--json]
// No dependencies.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const FS = /^(cat|ls|cp|mv|rm|rmdir|mkdir|touch|head|tail|wc|grep|rg|find|sed|awk|jq|echo|test|pwd|date|basename|dirname|sort|uniq|true|:)$/;
const PLUMBING = new Set(['state', 'script', 'git', 'fs']);

/** The program of a shell command, past `cd x &&`, env assignments and wrappers. */
function program(command) {
  const first = String(command).split(/&&|;|\|\||\n/).map((s) => s.trim()).filter((s) => s && !/^cd\b/.test(s) && !/^[A-Za-z_]\w*=\S*$/.test(s))[0] || '';
  const words = first.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '').split(/\s+/);
  return { first, name: (words[0] || '').split('/').pop(), words };
}

/** What kind of work a tool call is. */
export function kindOf(tool, input = {}) {
  if (tool === 'Bash') {
    const p = program(input.command);
    if (/state\.mjs/.test(p.first)) return 'state';
    if (/(tracker|hosting)\.mjs/.test(p.first)) return 'tracker';
    if (p.name === 'node' && /\.mjs\b/.test(p.first)) return 'script';
    if (p.name === 'git') return 'git';
    if (FS.test(p.name)) return 'fs';
    if (/^(npm|npx|node|pnpm|yarn|make|cargo|go|pytest)$/.test(p.name)) return 'gate';
    return 'other';
  }
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'read';
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return 'write';
  if (tool === 'Skill') return 'skill';
  if (tool === 'Agent' || tool === 'Task') return 'agent';
  return 'other';
}

/** A command with its paths, ids and hashes blanked, so the same shape counts once. */
const shape = (command) => String(command).replace(/\/[\w./@+-]*/g, '<path>').replace(/\b[A-Z]{2,}-\d+\b/g, '<id>').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>').replace(/\s+/g, ' ').trim().slice(0, 110);

/** The prompt a kept run was given: the first user message of its session transcript, which the runtime keeps beside the trace. */
function promptOf(folder) {
  try {
    const projects = join(folder, 'config', 'projects');
    for (const d of readdirSync(projects).filter((n) => n.endsWith('-cwd'))) {
      for (const f of readdirSync(join(projects, d)).filter((n) => n.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(projects, d, f), 'utf8').split('\n')) {
          const r = line ? JSON.parse(line) : null;
          const c = r?.type === 'user' ? r.message?.content : null;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null;
          if (text) return (/<command-message>([^<]+)</.exec(text)?.[1] || text.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 90);
        }
      }
    }
  } catch { /* an older kept folder: no label */ }
  return null;
}

export function profile(path) {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'out', 'trace.jsonl') : path;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const kinds = {}; const turns = [];
  for (const r of rows) {
    if (r.type !== 'assistant' || !r.message) continue;
    const u = r.message.usage || {};
    tokens.input += u.input_tokens || 0; tokens.cacheRead += u.cache_read_input_tokens || 0; tokens.cacheWrite += u.cache_creation_input_tokens || 0; tokens.output += u.output_tokens || 0;
    const content = Array.isArray(r.message.content) ? r.message.content : [];
    const calls = content.filter((c) => c.type === 'tool_use').map((c) => ({ tool: c.name, kind: kindOf(c.name, c.input), command: c.name === 'Bash' ? c.input?.command : null }));
    const talk = content.filter((c) => c.type === 'text').reduce((n, c) => n + (c.text || '').length, 0);
    for (const c of calls) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    turns.push({ calls, talk, mechanical: calls.length > 0 && talk < 240 && calls.every((c) => PLUMBING.has(c.kind)) });
  }
  const mech = turns.filter((t) => t.mechanical);
  const shapes = {};
  for (const t of mech) for (const c of t.calls) if (c.command) shapes[shape(c.command)] = (shapes[shape(c.command)] || 0) + 1;
  return { prompt: existsSync(path) && statSync(path).isDirectory() ? promptOf(path) : null, turns: turns.length, calls: turns.reduce((n, t) => n + t.calls.length, 0), kinds, tokens, mechanicalTurns: mech.length, shapes: Object.entries(shapes).sort((a, b) => b[1] - a[1]) };
}

function render(name, p) {
  const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
  const lines = [
    `${p.prompt ? `${p.prompt}  (${name})` : name}`,
    `  ${p.turns} turns · ${p.calls} tool calls · output ${k(p.tokens.output)} · cache read ${k(p.tokens.cacheRead)} · cache write ${k(p.tokens.cacheWrite)}`,
    `  by kind: ${Object.entries(p.kinds).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x} ${n}`).join(' · ')}`,
    `  mechanical turns: ${p.mechanicalTurns} of ${p.turns} (${p.turns ? Math.round((100 * p.mechanicalTurns) / p.turns) : 0}%)`,
  ];
  for (const [s, n] of p.shapes.slice(0, 12)) lines.push(`    ${String(n).padStart(2)}× ${s}`);
  return lines.join('\n');
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) { console.error('usage: profile.mjs <kept folder | trace.jsonl> […] [--json]'); process.exit(2); }
  const out = paths.map((p) => ({ path: p, ...profile(p) }));
  console.log(args.includes('--json') ? JSON.stringify(out, null, 2) : out.map((o) => render(o.path, o)).join('\n\n'));
}
