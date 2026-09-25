#!/usr/bin/env node
// setup.mjs — which skills a project activates (skills/tp-setup/SKILL.md; skills/README.md § Using it, Install). The
// catalogue and its dependencies live here, once; the interview is the skill's; this script lists, checks and applies.
// Every skill is named <PREFIX><name> (below) so nothing it offers can collide with another skill in the runtime.
// A skill that is off is not deleted: its folder moves to <.claude>/skills/_off/<name>/ (the runtime lists nothing under
// a `_` folder) and comes back when it is switched on again. `<.claude>/pipeline.json` records the choice; the state
// script, the orchestrator, the runner and the doctor read it (an absent file means every skill is on).
//
//   node setup.mjs list <.claude>                       -> { groups: [{ name, why, skills: [{ name, description, requires, default, on, present }] }], pipeline }
//   node setup.mjs check <.claude> '{ "skills": [..] }' -> { skills: [the closure], added: [{ name, for }], off: [..] }; exit 1 on an unknown name
//   node setup.mjs apply <.claude> '{ "skills": [..], "by"? }' -> writes pipeline.json, moves folders; returns { on, off, moved: { off: [], on: [] }, pipeline }
//   node setup.mjs status <.claude>                     -> { pipeline, on, off, problems: [..] } (a skill on whose folder is missing, a dependency off)
//   node setup.mjs stages <.claude>                     -> { off: [stage names the state script leaves out] }   (release, accept, merge when off)
//
// pipeline.json: { "skills": { "<name>": true|false … }, "setAt": "<iso>", "by": "setup"|"<who>" }
// No dependencies.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every skill's name carries a prefix so that none of them can be confused with another skill the runtime offers —
// a built-in, a plugin's, a personal one. The folder, the frontmatter `name:` and the slash command are the same
// string: `skills/<PREFIX><name>/SKILL.md` is invoked as `/<PREFIX><name>`. Changing it means renaming the folders
// and rewriting every reference, so it is a constant, not a setting; the tests hold the pipeline to it.
export const PREFIX = 'tp-';

// the catalogue: every skill, its group, what it needs, and whether the interview preselects it
export const GROUPS = [
  { name: 'ticket pipeline', why: 'one ticket from pickup to a pushed, gated PR — the core; every other group builds on it', skills: [
    { name: 'tp-run-ticket', requires: ['tp-start-ticket', 'tp-triage', 'tp-plan', 'tp-implement', 'tp-create-pr', 'tp-verify'], default: true },
    { name: 'tp-start-ticket', requires: [], default: true },
    { name: 'tp-triage', requires: [], default: true },
    { name: 'tp-plan', requires: [], default: true },
    { name: 'tp-implement', requires: ['tp-verify'], default: true },
    { name: 'tp-create-pr', requires: ['tp-verify'], default: true },
    { name: 'tp-verify', requires: [], default: true },
  ] },
  { name: 'review and merge', why: 'an unbiased review loop and the merge into the base branch — off when people review and merge by hand', skills: [
    { name: 'tp-review', requires: ['tp-verify'], default: true },
    { name: 'tp-merge', requires: ['tp-review', 'tp-create-pr'], default: true },
  ] },
  { name: 'after the merge', why: 'the deployment watched, the criteria proven, the process improved — off when nothing deploys or a person checks', skills: [
    { name: 'tp-release', requires: [], default: true },
    { name: 'tp-accept', requires: [], default: true },
    { name: 'tp-retro', requires: [], default: true },
  ] },
  { name: 'the day', why: 'a day planned, run in parallel, watched and closed — the loop around the pipeline', skills: [
    { name: 'tp-plan-day', requires: ['tp-run-ticket'], default: true },
    { name: 'tp-inbox', requires: [], default: true },
    { name: 'tp-eod', requires: [], default: true },
    { name: 'tp-schedule', requires: ['tp-plan-day', 'tp-inbox', 'tp-eod'], default: false },
  ] },
  { name: 'tooling', why: 'the preflight, the status board, notifications, tickets', skills: [
    { name: 'tp-status', requires: [], default: true },
    { name: 'tp-doctor', requires: [], default: true },
    { name: 'tp-notify', requires: [], default: true },
    { name: 'tp-create-ticket', requires: [], default: true },
  ] },
];
export const CATALOGUE = Object.fromEntries(GROUPS.flatMap((g) => g.skills.map((s) => [s.name, { ...s, group: g.name }])));
// which pipeline stages the state script leaves out when a skill is off (the core stages are never off in a run)
const STAGE_OF = { 'tp-merge': 'merge', 'tp-release': 'release', 'tp-accept': 'accept' };
const ALWAYS = [`${PREFIX}setup`]; // never listed, never off: the interview itself

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function places(claudeDir) {
  const root = resolve(String(claudeDir));
  return { root, skills: join(root, 'skills'), off: join(root, 'skills', '_off'), file: join(root, 'pipeline.json') };
}
function description(p, name) {
  for (const dir of [join(p.skills, name), join(p.off, name)]) {
    const f = join(dir, 'SKILL.md');
    if (!existsSync(f)) continue;
    const m = /^description:\s*(.+)$/m.exec(readFileSync(f, 'utf8'));
    return m ? m[1].trim() : '';
  }
  return '';
}
export function readPipeline(claudeDir) {
  const p = places(claudeDir);
  const j = readJson(p.file);
  if (!j || !j.skills || typeof j.skills !== 'object') return null;
  // a file written before the skills were prefixed still says what it meant: <name> is the skill <PREFIX><name>
  const skills = {};
  for (const [k, v] of Object.entries(j.skills)) skills[!CATALOGUE[k] && CATALOGUE[PREFIX + k] ? PREFIX + k : k] = v;
  return { ...j, skills };
}
const isOn = (pipeline, name) => (pipeline ? pipeline.skills[name] !== false : true);

export function list(claudeDir) {
  const p = places(claudeDir);
  const pipeline = readPipeline(claudeDir);
  return {
    groups: GROUPS.map((g) => ({ name: g.name, why: g.why, skills: g.skills.map((s) => ({ name: s.name, description: description(p, s.name), requires: s.requires, default: s.default, on: isOn(pipeline, s.name), present: isDir(join(p.skills, s.name)) })) })),
    pipeline,
  };
}

/** The closure of a selection under `requires`; `added` says what pulled each dependency in. */
export function check(input) {
  const wanted = Array.isArray(input?.skills) ? input.skills.map(String) : null;
  if (!wanted) throw new Error('skills must be an array of skill names');
  const unknown = wanted.filter((n) => !CATALOGUE[n] && !ALWAYS.includes(n));
  if (unknown.length) { const e = new Error(`unknown skill(s): ${unknown.join(', ')} — the catalogue is ${Object.keys(CATALOGUE).join(', ')}`); e.unknown = unknown; throw e; }
  const on = new Set(wanted.filter((n) => CATALOGUE[n]));
  const added = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...on]) for (const r of CATALOGUE[n].requires) if (!on.has(r)) { on.add(r); added.push({ name: r, for: n }); changed = true; }
  }
  const skills = Object.keys(CATALOGUE).filter((n) => on.has(n));
  return { skills, added, off: Object.keys(CATALOGUE).filter((n) => !on.has(n)) };
}

export function apply(claudeDir, input) {
  const p = places(claudeDir);
  const r = check(input);
  const moved = { off: [], on: [] };
  mkdirSync(p.off, { recursive: true });
  for (const name of Object.keys(CATALOGUE)) {
    const here = join(p.skills, name), away = join(p.off, name);
    if (r.skills.includes(name)) { if (!isDir(here) && isDir(away)) { renameSync(away, here); moved.on.push(name); } }
    else if (isDir(here)) { if (isDir(away)) throw new Error(`${name}: both skills/${name} and skills/_off/${name} exist — remove one`); renameSync(here, away); moved.off.push(name); }
  }
  const pipeline = { skills: Object.fromEntries(Object.keys(CATALOGUE).map((n) => [n, r.skills.includes(n)])), setAt: nowIso(), by: input?.by || 'setup' };
  writeFileSync(`${p.file}.tmp`, JSON.stringify(pipeline, null, 2) + '\n'); renameSync(`${p.file}.tmp`, p.file);
  return { on: r.skills, off: r.off, added: r.added, moved, pipeline };
}

export function status(claudeDir) {
  const p = places(claudeDir);
  const pipeline = readPipeline(claudeDir);
  const on = Object.keys(CATALOGUE).filter((n) => isOn(pipeline, n));
  const off = Object.keys(CATALOGUE).filter((n) => !isOn(pipeline, n));
  const problems = [];
  for (const n of on) {
    if (!isDir(join(p.skills, n))) problems.push(`${n} is on but skills/${n}/ is missing${isDir(join(p.off, n)) ? ' (it sits in skills/_off/ — run /tp-setup, or node setup.mjs apply)' : ''}`);
    for (const r of CATALOGUE[n].requires) if (!on.includes(r)) problems.push(`${n} needs ${r}, which is off`);
  }
  for (const n of off) if (isDir(join(p.skills, n))) problems.push(`${n} is off but skills/${n}/ is still installed (node setup.mjs apply moves it)`);
  if (!isDir(join(p.skills, ALWAYS[0]))) problems.push('skills/tp-setup/ is missing — the interview cannot run');
  return { pipeline, on, off, problems };
}

/** The stages the state script leaves out: one per off skill that owns a stage. */
export function offStages(claudeDir) {
  const pipeline = readPipeline(claudeDir);
  if (!pipeline) return [];
  return Object.entries(STAGE_OF).filter(([skill]) => !isOn(pipeline, skill)).map(([, stage]) => stage);
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  const arg = () => (rest[0] ? JSON.parse(rest[0]) : {});
  try {
    if (!target) throw new Error('usage: setup.mjs list|check|apply|status|stages <.claude> [json]');
    if (cmd === 'list') out(list(target));
    else if (cmd === 'check') out(check(arg()));
    else if (cmd === 'apply') out(apply(target, arg()));
    else if (cmd === 'status') { const s = status(target); out(s); process.exit(s.problems.length ? 1 : 0); }
    else if (cmd === 'stages') out({ off: offStages(target) });
    else throw new Error('usage: setup.mjs list|check|apply|status|stages <.claude> [json]');
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(e.unknown ? 1 : 2);
  }
}
