#!/usr/bin/env node
// setup.mjs — which skills a project activates (skills/setup/SKILL.md; reference/using.md § Using it, Install). The catalogue and its
// dependencies live here, once; the interview is the skill's; this script lists, checks and applies.
// The skills belong to the plugin, which every project that enables it shares, so a project's choice is a record and changes nothing in the
// plugin: `<.claude>/pipeline.json` (versioned — the team's). The state script, the orchestrator, the runner and the doctor read it; an
// absent file means every skill is on. Names are bare (`merge`, `plan-day`): the plugin's namespace makes the command `/tp:merge`, and
// a pipeline.json written as `tp-merge` is read as `merge`.
//
//   node setup.mjs list <.claude>                       -> { groups: [{ name, why, skills: [{ name, command, description, requires, default, on }] }], pipeline }
//   node setup.mjs check <.claude> '{ "skills": [..] }' -> { skills: [the closure], added: [{ name, for }], off: [..] }; exit 1 on an unknown name
//   node setup.mjs apply <.claude> '{ "skills": [..], "by"? }' -> writes pipeline.json and the deny rules for the skills that are off into
//                                                          <.claude>/settings.json; returns { on, off, added, pipeline, settings: { file, added, removed } }
//   node setup.mjs sync <.claude>                       -> regenerates those deny rules from the current pipeline.json (what a person edited by hand)
//   node setup.mjs status <.claude>                     -> { pipeline, on, off, problems: [..], drift: { missing, stale } } — a dependency that is off, a
//                                                          name nobody knows; a deny rule missing or left over; exit 1 on either
//   node setup.mjs stages <.claude>                     -> { off: [stage names the state script leaves out] }   (release, accept, merge when off)
//   node setup.mjs research <.claude> [allow=<domain,domain>|none] [maxFetches=<n>]
//                                                       -> { research: { allow, maxFetches } }: the documentation sites the planning researcher may read
//                                                          (tiers.json `research`, which the fetch hook enforces); with no pair it only reports them
//   node setup.mjs migrate <.claude> [--fix]            -> { copy, pipeline, permissions, launch, nothingLeft }: what is left of a copy of the pipeline kept in the
//                                                          project's own .claude (folders to remove, `tp-` keys in pipeline.json, allow rules naming the copy,
//                                                          launch.json entries that start an office server other than this plugin's); exit 1 while something
//                                                          is left. --fix rewrites pipeline.json's keys and those launch entries; nothing is ever deleted
//
// pipeline.json: { "skills": { "<name>": true|false … }, "setAt": "<iso>", "by": "setup"|"<who>" }
// Enforcement has three readers of that one file: the state script (a stage whose skill is off is skipped), the deny rules this script generates
// (the model cannot invoke an off skill) and the plugin's off-skill hook (the person cannot type one). The rules are the only generated part:
// `Skill(skill:tp:<name>)` for a catalogue skill is this script's, every other rule and key in settings.json is the project's and is left as it is.
// No dependencies.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The plugin's own folder: its skills, its reference. A project's `.claude` is a different folder. */
export const PLUGIN_ROOT = resolve(HERE, '..');
/** The plugin's namespace: the skill `merge` is run as `/tp:merge` and loaded by the Skill tool as `tp:merge`. */
export const NS = 'tp:';
export const slash = (name) => `/${NS}${name}`;
/** `merge`, `tp:merge`, `/tp:merge` and an older `tp-merge` all name the same skill. */
export const normalize = (name) => String(name).replace(/^\/?tp[:-]/, '');

// the catalogue: every skill, its group, what it needs, and whether the interview preselects it
export const GROUPS = [
  { name: 'ticket pipeline', why: 'one ticket from pickup to a pushed, gated PR — the core; every other group builds on it', skills: [
    { name: 'run-ticket', requires: ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'verify'], default: true },
    { name: 'start-ticket', requires: [], default: true },
    { name: 'triage', requires: [], default: true },
    { name: 'plan', requires: [], default: true },
    { name: 'implement', requires: ['verify'], default: true },
    { name: 'create-pr', requires: ['verify'], default: true },
    { name: 'verify', requires: [], default: true },
  ] },
  { name: 'review and merge', why: 'an unbiased review loop and the merge into the base branch — off when people review and merge by hand', skills: [
    { name: 'review', requires: ['verify'], default: true },
    { name: 'merge', requires: ['review', 'create-pr'], default: true },
  ] },
  { name: 'after the merge', why: 'the deployment watched, the criteria proven, the process improved — off when nothing deploys or a person checks', skills: [
    { name: 'release', requires: [], default: true },
    { name: 'accept', requires: [], default: true },
    { name: 'retro', requires: [], default: true },
  ] },
  { name: 'the day', why: 'a day planned, run in parallel, watched and closed — the loop around the pipeline', skills: [
    { name: 'plan-day', requires: ['run-ticket'], default: true },
    { name: 'inbox', requires: [], default: true },
    { name: 'eod', requires: [], default: true },
    { name: 'schedule', requires: ['plan-day', 'inbox', 'eod'], default: false },
  ] },
  { name: 'tooling', why: 'the preflight, the status board, notifications, tickets', skills: [
    { name: 'status', requires: [], default: true },
    { name: 'doctor', requires: [], default: true },
    { name: 'notify', requires: [], default: true },
    { name: 'create-ticket', requires: [], default: true },
  ] },
];
export const CATALOGUE = Object.fromEntries(GROUPS.flatMap((g) => g.skills.map((s) => [s.name, { ...s, group: g.name }])));
// which pipeline stages the state script leaves out when a skill is off (the core stages are never off in a run)
const STAGE_OF = { merge: 'merge', release: 'release', accept: 'accept' };
const ALWAYS = ['setup']; // never listed, never off: the interview itself

/** Text an older install stored names its commands `/tp-<skill>`; today's are `/tp:<skill>`. Applied to what the state files hand back, never to what is stored. */
const LEGACY_COMMAND = new RegExp(`(?<![\\w/.:-])/tp-(${[...Object.keys(CATALOGUE), ...ALWAYS, 'run-ticket-unattended'].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`, 'g');
export const modern = (text) => (typeof text === 'string' ? text.replace(LEGACY_COMMAND, '/tp:$1') : text);

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const writeJson = (file, obj) => { writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n'); renameSync(`${file}.tmp`, file); };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const pipelineFile = (claudeDir) => join(resolve(String(claudeDir)), 'pipeline.json');
const skillDir = (name) => join(PLUGIN_ROOT, 'skills', name);
function description(name) {
  const f = join(skillDir(name), 'SKILL.md');
  if (!existsSync(f)) return '';
  const m = /^description:\s*(.+)$/m.exec(readFileSync(f, 'utf8'));
  return m ? m[1].trim() : '';
}
export function readPipeline(claudeDir) {
  const j = readJson(pipelineFile(claudeDir));
  if (!j || !j.skills || typeof j.skills !== 'object') return null;
  const skills = {};
  for (const [k, v] of Object.entries(j.skills)) skills[normalize(k)] = v;
  return { ...j, skills };
}
const isOn = (pipeline, name) => (pipeline ? pipeline.skills[name] !== false : true);

export function list(claudeDir) {
  const pipeline = readPipeline(claudeDir);
  return {
    groups: GROUPS.map((g) => ({ name: g.name, why: g.why, skills: g.skills.map((s) => ({ name: s.name, command: slash(s.name), description: description(s.name), requires: s.requires, default: s.default, on: isOn(pipeline, s.name), present: isDir(skillDir(s.name)) })) })),
    pipeline,
  };
}

/** The closure of a selection under `requires`; `added` says what pulled each dependency in. */
export function check(input) {
  const wanted = Array.isArray(input?.skills) ? input.skills.map(normalize) : null;
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
  const r = check(input);
  loadSettings(claudeDir); // an unreadable settings.json stops everything before anything is written
  const file = pipelineFile(claudeDir);
  const pipeline = { skills: Object.fromEntries(Object.keys(CATALOGUE).map((n) => [n, r.skills.includes(n)])), setAt: nowIso(), by: input?.by || 'setup' };
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, pipeline);
  return { on: r.skills, off: r.off, added: r.added, pipeline, settings: sync(claudeDir) };
}

export function status(claudeDir) {
  const pipeline = readPipeline(claudeDir);
  const on = Object.keys(CATALOGUE).filter((n) => isOn(pipeline, n));
  const off = Object.keys(CATALOGUE).filter((n) => !isOn(pipeline, n));
  const problems = [];
  for (const n of on) for (const r of CATALOGUE[n].requires) if (!on.includes(r)) problems.push(`${n} needs ${r}, which is off`);
  if (pipeline) for (const n of Object.keys(pipeline.skills)) if (!CATALOGUE[n] && !ALWAYS.includes(n)) problems.push(`pipeline.json names ${n}, which is not a skill of this plugin`);
  for (const n of [...Object.keys(CATALOGUE), ...ALWAYS]) if (!isDir(skillDir(n))) problems.push(`the plugin has no skills/${n}/ — it is incomplete`);
  const { missing, stale } = enforcement(claudeDir);
  return { pipeline, on, off, problems, drift: { missing, stale } };
}

// ---- enforcement: the deny rules generated from pipeline.json ----------------------------------------------------------
/** The rule that stops the model from invoking a skill that is off; this script owns every rule of exactly this shape for a catalogue skill. */
export const denyRule = (name) => `Skill(skill:${NS}${name})`;
const OWNED = new RegExp(`^Skill\\(skill:${NS}(?:${Object.keys(CATALOGUE).join('|')})\\)$`);
const settingsFile = (claudeDir) => join(resolve(String(claudeDir)), 'settings.json');
function loadSettings(claudeDir) {
  const file = settingsFile(claudeDir);
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON — fix it first; nothing was changed`); }
}
const denied = (settings) => (Array.isArray(settings?.permissions?.deny) ? settings.permissions.deny.map(String) : []);

/** The deny rules pipeline.json calls for, the ones settings.json has, and the difference. */
export function enforcement(claudeDir) {
  const pipeline = readPipeline(claudeDir);
  const expected = Object.keys(CATALOGUE).filter((n) => !isOn(pipeline, n)).map(denyRule);
  const present = denied(readJson(settingsFile(claudeDir))).filter((r) => OWNED.test(r));
  return { file: settingsFile(claudeDir), expected, missing: expected.filter((r) => !present.includes(r)), stale: present.filter((r) => !expected.includes(r)) };
}

/** Writes the generated deny rules into <.claude>/settings.json — every other key and rule stays as it is — and says what changed. */
export function sync(claudeDir) {
  const settings = loadSettings(claudeDir);
  const { file, expected, missing, stale } = enforcement(claudeDir);
  if (!missing.length && !stale.length) return { file, added: [], removed: [] };
  const deny = denied(settings).filter((r) => !OWNED.test(r)).concat(expected);
  const permissions = { ...(settings.permissions || {}) };
  if (deny.length) permissions.deny = deny; else delete permissions.deny;
  const next = { ...settings, permissions };
  if (!Object.keys(permissions).length) delete next.permissions;
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, next);
  return { file, added: missing, removed: stale };
}

/** The stages the state script leaves out: one per off skill that owns a stage. */
export function offStages(claudeDir) {
  const pipeline = readPipeline(claudeDir);
  if (!pipeline) return [];
  return Object.entries(STAGE_OF).filter(([skill]) => !isOn(pipeline, skill)).map(([, stage]) => stage);
}

const OFFICE = join('office', 'serve.mjs');
/**
 * The `launch.json` entries that start an office server other than this plugin's: the project's own copy (`node office/serve.mjs`, run from
 * `<.claude>`) or the folder of another version of the plugin in the runtime's cache, which an update leaves behind.
 */
function officeLaunches(root) {
  const file = join(root, 'launch.json');
  const doc = readJson(file);
  const here = join(PLUGIN_ROOT, OFFICE);
  const old = (arg, c) => {
    const abs = isAbsolute(arg) ? arg : resolve(c.cwd ? resolve(root, c.cwd) : dirname(root), arg);
    return abs !== here && (abs === join(root, OFFICE) || /\/plugins\/cache\/[^/]+\/tp\/[^/]+\/office\/serve\.mjs$/.test(abs));
  };
  const entries = (Array.isArray(doc?.configurations) ? doc.configurations : []).filter((c) => c?.runtimeExecutable === 'node' && Array.isArray(c.runtimeArgs) && c.runtimeArgs.some((a) => typeof a === 'string' && old(a, c)));
  return { file, doc, entries, old };
}

/** Points those entries at this plugin's server and at this project's work directory (the copy found `work/` by sitting next to it). */
function repointOffice(root, { file, doc, entries, old }) {
  for (const c of entries) {
    c.runtimeArgs = c.runtimeArgs.map((a) => (typeof a === 'string' && old(a, c) ? join(PLUGIN_ROOT, OFFICE) : a));
    if (!c.runtimeArgs.includes('--work')) c.runtimeArgs.push('--work', join(root, 'work'));
  }
  writeJson(file, doc);
}

/** What is left of a project-local copy of the pipeline in `<.claude>` — read-only, except `fix`, which rewrites an older pipeline.json's `tp-` keys as bare names and points a launch.json office entry at the plugin's server. */
export function migrate(claudeDir, { fix = false } = {}) {
  const root = resolve(String(claudeDir));
  const copy = [];
  const skills = join(root, 'skills');
  if (isDir(skills)) for (const n of readdirSync(skills).sort()) if (/^tp-/.test(n) || ['_lib', '_off', 'README.md', 'flowcharts.md'].includes(n)) copy.push(`skills/${n}`);
  if (existsSync(join(root, 'workflows', 'tp-run-ticket-unattended.js'))) copy.push('workflows/tp-run-ticket-unattended.js');
  if (existsSync(join(root, 'tests', 'helpers.mjs')) && existsSync(join(root, 'tests', 'state.test.mjs'))) copy.push('tests'); // only when they are the pipeline's
  if (existsSync(join(root, 'office', 'serve.mjs'))) copy.push('office');
  const file = pipelineFile(claudeDir);
  const raw = readJson(file);
  const legacyKeys = raw && raw.skills && typeof raw.skills === 'object' ? Object.keys(raw.skills).filter((k) => /^tp-/.test(k)) : [];
  let fixed = false;
  if (fix && legacyKeys.length) {
    const next = { ...raw, skills: Object.fromEntries(Object.entries(raw.skills).map(([k, v]) => [normalize(k), v])) };
    writeJson(file, next);
    fixed = true;
  }
  const permissions = [];
  for (const name of ['settings.local.json', 'settings.json']) {
    for (const rule of readJson(join(root, name))?.permissions?.allow || []) {
      if (String(rule).includes(`${root}/skills/_lib`) || String(rule).includes(`${root}/office`)) permissions.push({ file: name, rule: String(rule) });
    }
  }
  const launches = officeLaunches(root);
  if (fix && launches.entries.length) repointOffice(root, launches);
  const launch = launches.entries.map((c) => ({ name: c.name, fixed: fix }));
  return { copy, pipeline: { legacyKeys, fixed }, permissions, launch, nothingLeft: !copy.length && !legacyKeys.length && !permissions.length && !launch.length };
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The documentation sites the planning researcher may read: `allow` is domains ("docs.example.com,other.org", or "none" for the codebase alone) and
 * `maxFetches` the most pages one research may read. Merged into tiers.json's `research`; nothing else in the file is touched. Called with neither it reads.
 */
export function setResearch(claudeDir, { allow, maxFetches } = {}) {
  const file = join(resolve(String(claudeDir)), 'tiers.json');
  const tiers = readJson(file);
  if (!tiers || typeof tiers !== 'object') throw new Error(`${file} is missing or not valid JSON — /tp:setup writes it, with the ceiling`);
  const research = { ...(tiers.research && typeof tiers.research === 'object' ? tiers.research : {}) };
  if (allow !== undefined) {
    const list = String(allow).trim().toLowerCase() === 'none' ? [] : String(allow).split(',').map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    const bad = list.filter((d) => !HOST.test(d));
    if (bad.length) throw new Error(`not a domain: ${bad.join(', ')} — name hosts such as docs.example.com, comma-separated, or "none"`);
    research.allow = [...new Set(list)];
  }
  if (maxFetches !== undefined) {
    const n = Number(maxFetches);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('maxFetches is a whole number of pages, 1 to 100');
    research.maxFetches = n;
  }
  if (allow !== undefined || maxFetches !== undefined) writeJson(file, { ...tiers, research });
  return { research: { allow: [], maxFetches: 8, ...research } };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  const arg = () => (rest[0] ? JSON.parse(rest[0]) : {});
  try {
    if (!target) throw new Error('usage: setup.mjs list|check|apply|sync|status|stages|research|migrate <.claude> [json]');
    if (cmd === 'list') out(list(target));
    else if (cmd === 'check') out(check(arg()));
    else if (cmd === 'apply') out(apply(target, arg()));
    else if (cmd === 'sync') out(sync(target));
    else if (cmd === 'status') { const s = status(target); out(s); process.exit(s.problems.length || s.drift.missing.length || s.drift.stale.length ? 1 : 0); }
    else if (cmd === 'stages') out({ off: offStages(target) });
    else if (cmd === 'migrate') { const m = migrate(target, { fix: rest.includes('--fix') }); out(m); process.exit(m.nothingLeft ? 0 : 1); }
    else if (cmd === 'research') out(setResearch(target, Object.fromEntries(rest.map((p) => { const i = p.indexOf('='); if (i < 1) throw new Error(`bad pair "${p}" — use allow=<domain,domain>|none and maxFetches=<n>`); return [p.slice(0, i), p.slice(i + 1)]; }))));
    else throw new Error('usage: setup.mjs list|check|apply|sync|status|stages|research|migrate <.claude> [json]');
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(e.unknown ? 1 : 2);
  }
}
