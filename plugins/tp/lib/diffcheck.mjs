#!/usr/bin/env node
// diffcheck.mjs — the mechanical half of diff validation (skills/create-pr/instructions/diff-validation.md): every changed file of a branch, or of one
// round's delta, sorted into Expected / Supporting / Unexpected from the plan and the file's own name, plus the warning signs that need no judgment.
// What is left — an Unexpected file, a warning — is what a reading agent is for; a diff with none of either needs no agent at all, and the table is
// written from this script's output. It runs on the developer's machine from `git diff` and the plan, so the check costs no tokens and cannot drift.
//
//   node diffcheck.mjs '{ "repo": "<worktree>", "base": "origin/main", "workdir": "<.claude>/work/<id>" }'            -> the JSON below (a creation round)
//   node diffcheck.mjs '{ "repo", "since": "<sha validated through>", "workdir" }'                                    -> the same for the commits since (an update round)
//   … --render [--title "<text>"]                                                                                      -> the diff-validation.md table instead (rows of this range only)
//
//   { repo, range, head, files: [{ path, from?, status: A|M|D|R, additions, deletions, class: expected|supporting|unexpected, step?, why }],
//     counts: { expected, supporting, unexpected }, changed: { files, additions, deletions }, warnings: [..], verdict: "clean" | "review" }
// `plan` may be given as a path instead of `workdir` (its plan.md). With no plan every file but a lockfile, a test or a generated one is Unexpected: there is
// nothing to compare with, so the verdict is "review". No dependencies beyond git and the plan parser.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './contract/plan.mjs';

const TEST = [/(^|\/)(tests?|__tests__|specs?)\//, /\.(test|spec)\.[a-z0-9]+$/i, /_test\.(go|py|rb|exs?)$/, /(^|\/)test_[^/]+\.py$/, /Tests?\.(java|kt|cs|swift)$/];
const LOCKFILES = { 'package-lock.json': 'package.json', 'npm-shrinkwrap.json': 'package.json', 'yarn.lock': 'package.json', 'pnpm-lock.yaml': 'package.json', 'bun.lockb': 'package.json', 'Cargo.lock': 'Cargo.toml', 'go.sum': 'go.mod', 'poetry.lock': 'pyproject.toml', 'Pipfile.lock': 'Pipfile', 'Gemfile.lock': 'Gemfile', 'composer.lock': 'composer.json', 'mix.lock': 'mix.exs', 'pubspec.lock': 'pubspec.yaml' };
const GENERATED = [/(^|\/)__snapshots__\//, /\.snap$/, /(^|\/)(dist|build|out|coverage)\//, /\.generated\./, /(^|\/)generated\//, /\.min\.(js|css)$/, /\.map$/];
const SCHEMA = /(^|\/)(schema\.prisma|[^/]+\.prisma|schema\.rb|structure\.sql)$/;
const MIGRATION = /(^|\/)(migrations?|db\/migrate)\//;
const PATH_LIKE = /^(?:[\w@.+-]+\/)+[\w@.+-]*$|^[\w@+-]+(?:\.[\w@+-]+)*\.[A-Za-z0-9]+$/;
const BIG_FILE = 400;
const FOCUSED = 10;

const clean = (p) => String(p).replace(/^\.\//, '').replace(/^\/+/, '');
const stem = (p) => basename(p).replace(/\.(test|spec)(?=\.)/i, '').replace(/(_test|Tests?)(?=\.)/, '').replace(/\.[^.]+$/, '').replace(/^test_/, '');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The changed files of a range with their status and line counts, renames followed. */
function changed(repo, range) {
  const files = new Map();
  const status = git(repo, ['diff', '--name-status', '-z', '-M', '--no-color', range]).split('\0');
  for (let i = 0; i < status.length - 1;) {
    const code = status[i++];
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') { const from = status[i++]; const path = status[i++]; files.set(path, { path, from, status: 'R' }); } else { const path = status[i++]; files.set(path, { path, status: code[0] }); }
  }
  const num = git(repo, ['diff', '--numstat', '-z', '-M', '--no-color', range]).split('\0');
  for (let i = 0; i < num.length - 1;) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(num[i++]);
    if (!m) continue;
    let path = m[3];
    if (path === '') { i++; path = num[i++]; } // a rename: the two names follow
    const f = files.get(path);
    if (f) { f.binary = m[1] === '-'; f.additions = f.binary ? 0 : Number(m[1]); f.deletions = f.binary ? 0 : Number(m[2]); }
  }
  return [...files.values()].map((f) => ({ additions: 0, deletions: 0, ...f }));
}

/** The files a plan's steps name, as path → step number (a name ending in `/` stands for the folder). */
function planned(planText) {
  const out = new Map();
  if (!planText) return { files: out, steps: 0 };
  const plan = parsePlan(planText);
  for (const s of plan.steps) for (const f of s.files || []) if (f.path && !out.has(clean(f.path))) out.set(clean(f.path), s.n);
  if (!out.size) { // a plan that is notes rather than the template (direct work): every path-like thing it puts in backticks, outside a code fence
    const prose = String(planText).replace(/```[\s\S]*?```/g, '');
    for (const m of prose.matchAll(/`([^`\n]+)`/g)) if (PATH_LIKE.test(m[1].trim())) out.set(clean(m[1].trim()), 0);
  }
  return { files: out, steps: plan.steps.length };
}
const named = (files, path) => {
  for (const [p, n] of files) if (path === p || path.endsWith(`/${p}`) || p.endsWith(`/${path}`) || (p.endsWith('/') && path.startsWith(p))) return n;
  return null;
};

/**
 * The classification itself, from a list of changed files and the plan's text — no git, so it can be run over a diff that is no longer there.
 * `all`: [{ path, status, additions, deletions, binary?, from? }]; `generatedAttr`: paths git marks linguist-generated.
 */
export function classify(all, planText, generatedAttr = new Set()) {
  const { files: planFiles, steps } = planned(planText);
  const paths = new Set(all.map((f) => f.path));
  const expectedStems = new Set();
  for (const f of all) if (named(planFiles, f.path) !== null) expectedStems.add(stem(f.path));

  const files = all.map((f) => {
    const step = named(planFiles, f.path);
    let cls = 'unexpected'; let why = planFiles.size ? 'not named by the plan' : 'there is no plan to compare with';
    const lock = LOCKFILES[basename(f.path)];
    if (step !== null) { cls = 'expected'; why = step ? `plan step ${step} names it` : 'the plan names it'; }
    else if (lock) {
      if ([...paths].some((p) => basename(p) === lock)) { cls = 'supporting'; why = `the lockfile of ${lock}, which changed too`; } else why = `a lockfile changed without its manifest (${lock})`;
    } else if (GENERATED.some((re) => re.test(f.path)) || generatedAttr.has(f.path)) {
      if (expectedStems.size || [...paths].some((p) => p !== f.path)) { cls = 'supporting'; why = 'generated: its source changed with it'; }
    } else if (MIGRATION.test(f.path) && [...paths].some((p) => SCHEMA.test(p))) {
      cls = 'supporting'; why = 'a migration, and the schema it follows changed too';
    } else if (TEST.some((re) => re.test(f.path))) {
      if (expectedStems.has(stem(f.path))) { cls = 'supporting'; why = `a test for ${[...paths].find((p) => stem(p) === stem(f.path) && !TEST.some((re) => re.test(p))) || 'a changed file'}`; }
      else if (expectedStems.size) { cls = 'supporting'; why = 'a test alongside the change'; }
      else why = 'a test with no expected change beside it';
    } else if (f.status === 'D') why = 'deleted, and the plan does not name it';
    else if (f.binary) why = 'a binary file the plan does not name';
    return { path: f.path, ...(f.from ? { from: f.from } : {}), status: f.status, additions: f.additions, deletions: f.deletions, class: cls, ...(step !== null ? { step } : {}), why };
  }).sort((a, b) => ['expected', 'supporting', 'unexpected'].indexOf(a.class) - ['expected', 'supporting', 'unexpected'].indexOf(b.class) || a.path.localeCompare(b.path));

  const warnings = [];
  if (files.length > FOCUSED && steps <= 3) warnings.push(`more than ~${FOCUSED} files for a focused fix: ${files.length} files, ${steps} plan step${steps === 1 ? '' : 's'}`);
  if (files.some((f) => SCHEMA.test(f.path)) && !files.some((f) => MIGRATION.test(f.path))) warnings.push('a schema change without its migration');
  if (files.some((f) => MIGRATION.test(f.path)) && !files.some((f) => SCHEMA.test(f.path))) warnings.push('a migration without a schema change');
  for (const f of files) if (f.additions + f.deletions > BIG_FILE && f.class !== 'supporting') warnings.push(`a large change in ${f.path} (${f.additions + f.deletions} lines): read its hunks`);
  for (const f of files) if (all.find((x) => x.path === f.path)?.binary && f.class !== 'supporting') warnings.push(`a binary file: ${f.path}`);

  const counts = { expected: 0, supporting: 0, unexpected: 0 };
  for (const f of files) counts[f.class]++;
  return {
    files, counts,
    changed: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
    warnings, verdict: counts.unexpected === 0 && warnings.length === 0 ? 'clean' : 'review',
  };
}

export function diffcheck({ repo, base, since, plan, workdir }) {
  if (!repo || !(base || since)) throw new Error('usage: diffcheck.mjs \'{ "repo": "<worktree>", "base": "<ref>" | "since": "<sha>", "workdir"?: …, "plan"?: … }\'');
  const range = since ? `${since}..HEAD` : `${base}...HEAD`;
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const planFile = plan || (workdir ? join(workdir, 'plan.md') : null);
  const all = changed(repo, range);
  const generatedAttr = new Set();
  if (all.length) {
    const attr = git(repo, ['check-attr', '-z', 'linguist-generated', '--', ...all.map((f) => f.path)]).split('\0');
    for (let i = 0; i + 2 < attr.length; i += 3) if (attr[i + 2] === 'set' || attr[i + 2] === 'true') generatedAttr.add(attr[i]);
  }
  return { repo, range, head, ...classify(all, planFile && existsSync(planFile) ? readFileSync(planFile, 'utf8') : '', generatedAttr) };
}

/** The diff-validation.md table for this range, as the instructions describe it — `Validated through` last, the next round's starting point. */
export function renderDiff(r, { title } = {}) {
  const label = { expected: 'Expected', supporting: 'Supporting', unexpected: 'Unexpected' };
  const lines = [`## ${title || `Diff validation — ${r.range}`}`, '', `${r.changed.files} file${r.changed.files === 1 ? '' : 's'}, +${r.changed.additions} −${r.changed.deletions}. Expected ${r.counts.expected} · Supporting ${r.counts.supporting} · Unexpected ${r.counts.unexpected}.`, ''];
  if (r.files.length) {
    lines.push('| File | Class | Reasoning |', '|---|---|---|');
    for (const f of r.files) lines.push(`| ${f.from ? `${f.from} → ` : ''}${f.path} | ${label[f.class]} | ${f.why} |`);
    lines.push('');
  } else lines.push('No file changed in this range.', '');
  if (r.warnings.length) lines.push('Warning signs:', ...r.warnings.map((w) => `- ${w}`), '');
  lines.push(`Validated through: ${r.head}`);
  return lines.join('\n');
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const input = JSON.parse(args.find((a) => a.trim().startsWith('{')) || '{}');
    const r = diffcheck(input);
    const t = args.indexOf('--title');
    console.log(args.includes('--render') ? renderDiff(r, { title: t >= 0 ? args[t + 1] : undefined }) : JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(String(e.message || e).split('\n')[0]);
    process.exit(2);
  }
}
