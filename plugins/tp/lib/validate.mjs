#!/usr/bin/env node
// Check the work directory's files against their schemas (schemas/README.md). A command-line front for lib/contract/; nothing else lives here.
//
//   node validate.mjs file <path> [--as <artifact>] [--mode write|read]
//                      -> { ok, artifact, errors: ["$.path: message", …] }          exit 0 valid, 1 invalid
//   node validate.mjs work <workdir|workroot> [--mode read|write]
//                      -> { ok, checked, invalid: [{ file, errors }] }              a ticket's directory (has ticket.json) or the whole work root
//   node validate.mjs artifacts                                                     -> the artifact kinds and the files each covers
//
// `write` is the contract as it is today (what `state.mjs put` enforces); `read` also accepts the shapes earlier runs wrote
// (default for `work`: it reports drift without calling an old ticket broken). Output is one line of JSON; exit 2 is a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ARTIFACTS, artifactOf, checkArtifact, checkWorkdir, checkWorkroot } from './contract/index.mjs';

const usage = (msg) => { console.error(`${msg ? `${msg}\n` : ''}usage: validate.mjs file <path> [--as <artifact>] [--mode write|read] | work <workdir|workroot> [--mode read|write] | artifacts`); process.exit(2); };
const flags = (list) => { const o = {}; for (let i = 0; i < list.length; i++) if (String(list[i]).startsWith('--')) o[list[i].slice(2)] = list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[++i] : true; return o; };
const out = (obj, ok) => { process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(ok ? 0 : 1)); };

const [, , cmd, target, ...rest] = process.argv;
const o = flags(rest);
const mode = o.mode === 'read' ? 'read' : o.mode === 'write' ? 'write' : null;
if (o.mode && !mode) usage('--mode is write or read');

if (cmd === 'file') {
  if (!target || !existsSync(target)) usage(`no such file: ${target}`);
  const artifact = o.as || artifactOf(basename(target))?.artifact;
  if (!artifact || !ARTIFACTS.includes(artifact)) usage(`${basename(target)} is not a known artifact (${ARTIFACTS.join(', ')}); name it with --as`);
  let value;
  try { value = JSON.parse(readFileSync(target, 'utf8')); } catch (e) { out({ ok: false, artifact, errors: [`$: not valid JSON — ${e.message}`] }, false); }
  if (value !== undefined) { const r = checkArtifact(artifact, value, { mode: mode || 'write' }); out({ ok: r.ok, artifact, errors: r.errors }, r.ok); }
} else if (cmd === 'work') {
  if (!target || !existsSync(target)) usage(`no such directory: ${target}`);
  const single = existsSync(join(target, 'ticket.json')); // a ticket's directory has one; the work root only holds directories (and the odd stray file)
  const r = single ? checkWorkdir(target, { mode: mode || 'read' }) : checkWorkroot(target, { mode: mode || 'read' });
  out({ ok: r.invalid.length === 0, checked: r.checked, invalid: r.invalid }, r.invalid.length === 0);
} else if (cmd === 'artifacts') {
  out({ artifacts: ARTIFACTS, files: { ticket: 'ticket.json', triage: 'triage.json', plan: 'plan.json', 'plan-check': 'plan-check.json', implement: 'implement[.<repo>].json', pr: 'pr[.<repo>].json', release: 'release[.<repo>].json', accept: 'accept.json', retro: 'retro.json', quality: 'quality.json', research: 'research.json' } }, true);
} else usage();
