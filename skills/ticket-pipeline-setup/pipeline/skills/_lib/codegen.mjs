#!/usr/bin/env node
// codegen.mjs — generated code the build and the gates depend on (skills/README.md § Toolchain). An ORM client, a
// GraphQL or protobuf stub, a typed API client is written by a tool from a schema in the repo; when the schema moves
// ahead of the generated output, a type-aware gate reports the mismatch as dozens of errors in code nobody touched.
// This script says what the project generates, from which inputs, and whether it is behind — so a stage regenerates
// once, deliberately, instead of a reviewer reading invented findings.
//
//   node codegen.mjs detect '{ repo, claudeDir }'
//        -> { command, runner, source, inputs: [paths], outputs: [paths], marker }  (command null: the project generates nothing)
//   node codegen.mjs status '{ repo, claudeDir }'
//        -> the same plus { stale, why, hash, ranAt }; exit 0 current or nothing to generate, 1 stale
//        stale when: an output the tool is known to write is missing, or the inputs' content hash differs from the one
//        recorded at the last run (a checkout, a pull, a rebase — mtimes are not trusted, contents are)
//   node codegen.mjs mark '{ repo, claudeDir }'   -> records the inputs' hash as generated-from (after a successful run)
//
// tiers.json.codegen (defaults): { command: null, inputs: [], enabled: true }
//   command/inputs -> the escape hatch for a toolchain this file does not know; `enabled: false` turns the check off.
// Resolution, like every other command the pipeline runs (hooks.mjs § the runners): tiers.json -> a target the project
// itself defines (a `generate`/`codegen` script, a Makefile target) -> the tool the repo's own config implies.
// No dependencies.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnersOf } from './hooks.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', '.turbo', 'coverage', '__pycache__']);

/** Files matching `re` under the repo, breadth-first, capped — enough to hash a schema set, never a source tree. */
function find(repo, re, cap = 40, depth = 4) {
  const out = [];
  const walk = (dir, level) => {
    if (out.length >= cap || level > depth) return;
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.config') { if (!re.test(e.name)) continue; }
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, level + 1); continue; }
      if (re.test(e.name)) out.push(p);
    }
  };
  walk(repo, 0);
  return out.sort();
}

// the generators this file knows: the marker that says the project uses it, its command, its inputs, what it writes
const GENERATORS = [
  { name: 'prisma', marker: (r) => find(r, /\.prisma$/, 5, 3).length > 0,
    cmd: 'prisma generate', exec: true, inputs: (r) => find(r, /\.prisma$/, 5, 3),
    outputs: (r) => [join(r, 'node_modules', '.prisma', 'client')] },
  { name: 'graphql-codegen', marker: (r) => ['codegen.ts', 'codegen.yml', 'codegen.yaml', 'codegen.json'].some((n) => isFile(join(r, n))),
    cmd: 'graphql-codegen', exec: true, inputs: (r) => [...find(r, /^codegen\.(ts|yml|yaml|json)$/, 4, 1), ...find(r, /\.graphql$/, 20, 3)] },
  { name: 'sqlc', marker: (r) => ['sqlc.yaml', 'sqlc.yml', 'sqlc.json'].some((n) => isFile(join(r, n))),
    cmd: 'sqlc generate', inputs: (r) => [...find(r, /^sqlc\.(ya?ml|json)$/, 3, 1), ...find(r, /\.sql$/, 30, 4)] },
  { name: 'buf', marker: (r) => ['buf.gen.yaml', 'buf.gen.yml'].some((n) => isFile(join(r, n))),
    cmd: 'buf generate', inputs: (r) => [...find(r, /^buf\.(gen\.)?ya?ml$/, 4, 1), ...find(r, /\.proto$/, 30, 4)] },
  { name: 'drizzle', marker: (r) => find(r, /^drizzle\.config\.(ts|js|mjs|json)$/, 2, 1).length > 0,
    cmd: 'drizzle-kit generate', exec: true, inputs: (r) => find(r, /^drizzle\.config\.(ts|js|mjs|json)$/, 2, 1) },
  { name: 'ent', marker: (r) => isDir(join(r, 'ent')) && isFile(join(r, 'go.mod')),
    cmd: 'go generate ./ent', inputs: (r) => find(join(r, 'ent'), /\.go$/, 20, 2) },
  { name: 'go:generate', marker: (r) => isFile(join(r, 'go.mod')) && find(r, /\.go$/, 30, 3).some((f) => readFileSync(f, 'utf8').includes('//go:generate')),
    cmd: 'go generate ./...', inputs: (r) => find(r, /\.go$/, 30, 3).filter((f) => readFileSync(f, 'utf8').includes('//go:generate')) },
];

function config(claudeDir) {
  const t = claudeDir ? readJson(join(resolve(String(claudeDir)), 'tiers.json')) || {} : {};
  const c = t.codegen && typeof t.codegen === 'object' ? t.codegen : {};
  return { command: typeof c.command === 'string' && c.command.trim() ? c.command.trim() : null, inputs: Array.isArray(c.inputs) ? c.inputs : [], enabled: c.enabled !== false };
}
const markerFile = (repo, claudeDir) => join(resolve(String(claudeDir || repo)), 'work', '_scratch', 'codegen', `${basename(resolve(repo))}.json`);

/** A project target whose command generates code: the project's own word beats any guess. */
function projectTarget(repo) {
  const GEN = /\b(prisma generate|graphql-codegen|sqlc generate|buf generate|drizzle-kit (generate|push)|openapi-generator|swagger-codegen|protoc|go generate|ent generate|nswag|quicktype)\b/;
  for (const r of runnersOf(repo)) {
    if (!r.targets || !r.run) continue;
    const targets = r.targets(repo) || {};
    // a target named for generation, or one whose command is a generator
    const hit = Object.entries(targets).find(([name, cmd]) => GEN.test(String(cmd)) && /(^|[:_-])(gen|generate|codegen)([:_-]|$)/i.test(name))
      || Object.entries(targets).find(([, cmd]) => GEN.test(String(cmd)));
    if (hit) return { cmd: `${r.run} ${hit[0]}`, runner: r.name, source: `${r.name} target "${hit[0]}"`, body: targets[hit[0]] };
  }
  return null;
}

export function detect(input) {
  const repo = resolve(String(input?.repo || ''));
  if (!isDir(repo)) throw new Error('repo must be an existing checkout');
  const cfg = config(input?.claudeDir);
  const marker = markerFile(repo, input?.claudeDir);
  if (!cfg.enabled) return { repo, command: null, source: 'tiers.json codegen.enabled is false', inputs: [], outputs: [], marker };
  const gen = GENERATORS.find((g) => { try { return g.marker(repo); } catch { return false; } }) || null;
  const inputs = (cfg.inputs.length ? cfg.inputs.map((p) => resolve(repo, p)) : gen ? gen.inputs(repo) : []).filter(isFile);
  const outputs = gen && gen.outputs ? gen.outputs(repo) : [];
  if (cfg.command) return { repo, command: cfg.command, runner: 'tiers.json', source: 'tiers.json codegen.command', generator: gen ? gen.name : null, inputs, outputs, marker };
  const target = projectTarget(repo);
  if (target) return { repo, command: target.cmd, runner: target.runner, source: target.source, generator: gen ? gen.name : null, inputs, outputs, marker };
  if (!gen) return { repo, command: null, source: 'nothing generated', inputs: [], outputs: [], marker };
  // the tool the repo's config implies, run the way this ecosystem runs a local tool
  const exec = gen.exec ? (runnersOf(repo).find((r) => r.exec) || {}).exec || 'npx' : null;
  return { repo, command: exec ? `${exec} ${gen.cmd}` : gen.cmd, runner: exec ? exec.split(' ')[0] : gen.name, source: `${gen.name} config in the repo`, generator: gen.name, inputs, outputs, marker };
}

const hashOf = (files) => {
  if (!files.length) return null;
  const h = createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); try { h.update(readFileSync(f)); } catch { h.update('missing'); } }
  return h.digest('hex').slice(0, 16);
};

export function status(input) {
  const d = detect(input);
  if (!d.command) return { ...d, stale: false, why: d.source, hash: null, ranAt: null };
  const hash = hashOf(d.inputs);
  const rec = readJson(d.marker);
  const missing = d.outputs.filter((o) => !existsSync(o));
  if (missing.length) return { ...d, stale: true, why: `nothing generated yet: ${missing.map((m) => relative(d.repo, m)).join(', ')} is missing`, hash, ranAt: rec?.at || null };
  if (!rec || !rec.hash) return { ...d, stale: true, why: 'no record of a run for this checkout — generate once so later runs can tell', hash, ranAt: null };
  if (rec.hash !== hash) return { ...d, stale: true, why: `the inputs changed since the last run (${d.inputs.length} file(s): ${d.inputs.slice(0, 3).map((f) => relative(d.repo, f)).join(', ')}${d.inputs.length > 3 ? ', …' : ''})`, hash, ranAt: rec.at };
  return { ...d, stale: false, why: `current: generated from these inputs at ${rec.at}`, hash, ranAt: rec.at };
}

export function mark(input) {
  const d = detect(input);
  if (!d.command) return { ...d, marked: false, why: d.source };
  const hash = hashOf(d.inputs);
  mkdirSync(join(d.marker, '..'), { recursive: true });
  const rec = { repo: basename(d.repo), command: d.command, inputs: d.inputs.map((f) => relative(d.repo, f)), hash, at: nowIso() };
  writeFileSync(`${d.marker}.tmp`, JSON.stringify(rec, null, 2) + '\n');
  renameSync(`${d.marker}.tmp`, d.marker);
  return { ...d, marked: true, hash, at: rec.at };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = () => { if (!rest[0]) throw new Error('missing JSON argument'); return JSON.parse(rest[0]); };
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === 'detect') out(detect(arg()));
    else if (cmd === 'status') { const s = status(arg()); out(s); process.exit(s.stale ? 1 : 0); }
    else if (cmd === 'mark') out(mark(arg()));
    else { console.error("usage: codegen.mjs detect|status|mark '{ repo, claudeDir }'"); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(2); }
}
