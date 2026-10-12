#!/usr/bin/env node
// hosting.mjs — a file-backed hosting platform (reference/definitions.md § Definitions, Hosting platform): pull requests over the repos' own
// remotes, so the stages from /tp:create-pr to /tp:accept can be exercised end to end without a hosting account (reference/using.md § Using it,
// Simulation). Selected by <.claude>/hosting.json: { "kind": "fixture", "path": "/abs/hosting.json" }; without that file the skills use the
// connected platform's CLI and this script is never called. The verbs and flags are `gh`'s, the JSON field names too, so a model that knows one
// knows the other; what a pull request is stays real git: its head branch must be on the remote, its diff is a diff, its merge is a commit.
//
//   node hosting.mjs pr create [--repo r] [--base b] [--head h] --title t (--body s | --body-file f)   -> { number, url }
//   node hosting.mjs pr view <n|url> [--repo r] [--json f1,f2,…]    -> the pull request (number, url, title, body, state OPEN|MERGED|CLOSED, baseRefName,
//                                                                      headRefName, headRefOid, mergeCommit, mergeable, files, comments, reviews, statusCheckRollup …)
//   node hosting.mjs pr list [--repo r] [--head h] [--base b] [--state open|merged|closed|all] [--json fields]
//   node hosting.mjs pr comment <n> (--body s | --body-file f)     -> { number, comments, url }      (--body-file - reads stdin)
//   node hosting.mjs pr edit <n> [--title t] [--body s | --body-file f] [--base b]
//   node hosting.mjs pr diff <n> [--name-only | --stat]             -> the diff base...head, read from the remote
//   node hosting.mjs pr merge <n> [--merge | --squash | --rebase] [--delete-branch] [--subject s]   -> the merge commit is written into the remote
//   node hosting.mjs pr close <n>   |   node hosting.mjs pr checks <n>   (no pipeline: none reported)
//   node hosting.mjs run list [--branch b] [--commit sha]           -> the pipeline runs the fixture holds (none unless seeded)
//   node hosting.mjs me                                             -> { me, repos } — what `/tp:doctor` asks
//   --file <path> or --claude <.claude> select the fixture explicitly (default: hosting.json in the .claude of the project the session runs in)
//
// Fixture shape: { me, repos: { <name>: { remote: "/abs/bare.git", defaultBranch: "main" } }, prs: [ … ], runs: [ … ] }. A repo is found by --repo <name>,
// else by the `origin` of the directory the command runs in, else the only one. No dependencies.

import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const IDENTITY = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

export function flags(list) {
  const o = { _: [] };
  const valued = new Set(['repo', 'base', 'head', 'title', 'body', 'body-file', 'json', 'state', 'branch', 'commit', 'subject', 'file', 'claude']);
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (!a.startsWith('--')) { o._.push(list[i]); continue; }
    const k = a.slice(2);
    o[k] = valued.has(k) ? list[++i] : true;
  }
  return o;
}

export function fixturePath(opts = {}) {
  if (opts.file) return resolve(opts.file);
  const claudeDir = opts.claude ? resolve(opts.claude) : resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude');
  const cfg = join(claudeDir, 'hosting.json');
  if (!existsSync(cfg)) throw new Error(`${cfg} missing — this install uses the connected platform's CLI, not a fixture`);
  let c; try { c = JSON.parse(readFileSync(cfg, 'utf8')); } catch (e) { throw new Error(`${cfg} is not valid JSON: ${e.message}`); }
  if (c.kind !== 'fixture' || typeof c.path !== 'string') throw new Error(`${cfg} must be { "kind": "fixture", "path": "<abs path>" }`);
  return resolve(claudeDir, c.path);
}

export function load(file) {
  if (!existsSync(file)) throw new Error(`fixture ${file} missing`);
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f.repos || typeof f.repos !== 'object') throw new Error(`fixture ${file}: "repos" must map a repo name to { remote }`);
  f.prs ||= []; f.runs ||= [];
  return f;
}
function store(file, f) {
  writeFileSync(`${file}.tmp`, JSON.stringify(f, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

/** git against a repo's remote (a bare repository). */
function git(remote, args, opts = {}) {
  const r = spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0' }, input: opts.input });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sha = (remote, ref) => { const r = git(remote, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.code === 0 ? r.out : null; };

/** Which repo a command is about: --repo, else the origin of the directory it runs in, else the only one. */
function repoOf(f, o) {
  const names = Object.keys(f.repos);
  if (o.repo) { if (!f.repos[o.repo]) throw new Error(`no repo "${o.repo}" in the fixture (${names.join(', ')})`); return o.repo; }
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (url.status === 0) {
    const here = realOf(url.stdout.trim());
    const hit = names.find((n) => realOf(f.repos[n].remote) === here);
    if (hit) return hit;
  }
  if (names.length === 1) return names[0];
  throw new Error(`which repo? name one with --repo <${names.join('|')}>, or run the command in a checkout of it`);
}
const realOf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

const numberOf = (ref) => { const m = /(\d+)\/?$/.exec(String(ref ?? '').split('#')[0].replace(/\/$/, '')); if (!m) throw new Error(`not a pull request number or url: ${ref}`); return Number(m[1]); };
function find(f, repo, ref) {
  const n = numberOf(ref);
  const pr = f.prs.find((p) => p.repo === repo && p.number === n);
  if (!pr) throw new Error(`no pull request #${n} in ${repo}`);
  return pr;
}
const urlOf = (repo, n) => `fixture://${repo}/pull/${n}`;

/** A pull request as `gh pr view --json` reports it, with the fields that depend on the remote read live. */
export function shape(f, pr) {
  const remote = f.repos[pr.repo].remote;
  const open = pr.state === 'open';
  const head = open ? sha(remote, `refs/heads/${pr.head}`) : null;
  const base = sha(remote, `refs/heads/${pr.base}`);
  let mergeable = 'UNKNOWN';
  if (open && head && base) mergeable = git(remote, ['merge-tree', '--write-tree', base, head]).code === 0 ? 'MERGEABLE' : 'CONFLICTING';
  const files = open && head && base ? git(remote, ['diff', '--numstat', `${base}...${head}`]).out.split('\n').filter(Boolean).map((l) => { const [a, d, path] = l.split('\t'); return { path, additions: Number(a) || 0, deletions: Number(d) || 0 }; }) : (pr.files || []);
  return {
    number: pr.number, url: urlOf(pr.repo, pr.number), title: pr.title, body: pr.body, state: pr.state.toUpperCase(), isDraft: false,
    baseRefName: pr.base, headRefName: pr.head, headRefOid: head || pr.headSha || null,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, mergedAt: pr.mergedAt || null,
    mergeable, mergeStateStatus: mergeable === 'MERGEABLE' ? 'CLEAN' : mergeable === 'CONFLICTING' ? 'DIRTY' : 'UNKNOWN', reviewDecision: '',
    author: { login: f.me || 'me' }, createdAt: pr.createdAt, updatedAt: pr.updatedAt, labels: [],
    files, changedFiles: files.length, additions: files.reduce((s, x) => s + x.additions, 0), deletions: files.reduce((s, x) => s + x.deletions, 0),
    comments: pr.comments, reviews: [], statusCheckRollup: [],
  };
}
const pick = (obj, fields) => (fields ? Object.fromEntries(String(fields).split(',').map((k) => k.trim()).filter(Boolean).map((k) => { if (!(k in obj)) throw new Error(`unknown field "${k}" (fields: ${Object.keys(obj).join(', ')})`); return [k, obj[k]]; })) : obj);

const text = (o, what) => {
  if (o.body !== undefined && o.body !== true) return String(o.body);
  if (o['body-file']) return o['body-file'] === '-' ? readFileSync(0, 'utf8') : readFileSync(o['body-file'], 'utf8');
  throw new Error(`${what} needs --body <text> or --body-file <path>`);
};

export function create(file, f, o) {
  const repo = repoOf(f, o);
  const cfg = f.repos[repo];
  const head = o.head || spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const base = o.base || cfg.defaultBranch || 'main';
  if (!o.title || o.title === true) throw new Error('a pull request needs --title');
  const body = text(o, 'a pull request');
  if (!sha(cfg.remote, `refs/heads/${head}`)) throw new Error(`head branch "${head}" is not on the remote of ${repo} — push it first`);
  if (!sha(cfg.remote, `refs/heads/${base}`)) throw new Error(`base branch "${base}" is not on the remote of ${repo}`);
  if (head === base) throw new Error('the head and the base are the same branch');
  const dup = f.prs.find((p) => p.repo === repo && p.head === head && p.state === 'open');
  if (dup) throw new Error(`a pull request for branch "${head}" already exists: ${urlOf(repo, dup.number)}`);
  const n = f.prs.filter((p) => p.repo === repo).reduce((m, p) => Math.max(m, p.number), 0) + 1;
  const at = nowIso();
  f.prs.push({ number: n, repo, title: String(o.title), body, state: 'open', base, head, headSha: sha(cfg.remote, `refs/heads/${head}`), comments: [], createdAt: at, updatedAt: at });
  store(file, f);
  return { number: n, url: urlOf(repo, n) };
}

export function view(f, o) {
  const repo = repoOf(f, o);
  return pick(shape(f, find(f, repo, o._[0])), o.json);
}

export function list(f, o) {
  const repo = repoOf(f, o);
  const state = String(o.state || 'open').toLowerCase();
  return f.prs.filter((p) => p.repo === repo && (state === 'all' || p.state === state) && (!o.head || p.head === o.head) && (!o.base || p.base === o.base))
    .map((p) => pick(shape(f, p), o.json || 'number,url,title,state,baseRefName,headRefName,headRefOid'));
}

export function comment(file, f, o) {
  const repo = repoOf(f, o);
  const pr = find(f, repo, o._[0]);
  const body = text(o, 'a comment');
  if (!body.trim()) throw new Error('a comment needs text');
  pr.comments.push({ id: `c${pr.comments.length + 1}`, author: { login: f.me || 'me' }, body: body.trim(), createdAt: nowIso() });
  pr.updatedAt = nowIso();
  store(file, f);
  return { number: pr.number, comments: pr.comments.length, url: `${urlOf(repo, pr.number)}#comment-${pr.comments.length}` };
}

export function edit(file, f, o) {
  const repo = repoOf(f, o);
  const pr = find(f, repo, o._[0]);
  if (pr.state !== 'open') throw new Error(`pull request #${pr.number} is ${pr.state}`);
  if (o.title && o.title !== true) pr.title = String(o.title);
  if (o.body !== undefined || o['body-file']) pr.body = text(o, 'a description');
  if (o.base && o.base !== true) { if (!sha(f.repos[repo].remote, `refs/heads/${o.base}`)) throw new Error(`base branch "${o.base}" is not on the remote`); pr.base = o.base; }
  pr.updatedAt = nowIso();
  store(file, f);
  return { number: pr.number, url: urlOf(repo, pr.number) };
}

export function diff(f, o) {
  const repo = repoOf(f, o);
  const pr = find(f, repo, o._[0]);
  const remote = f.repos[repo].remote;
  const head = pr.state === 'open' ? sha(remote, `refs/heads/${pr.head}`) : pr.headSha;
  const r = git(remote, ['diff', ...(o['name-only'] ? ['--name-only'] : o.stat ? ['--stat'] : []), `${sha(remote, `refs/heads/${pr.base}`)}...${head}`]);
  if (r.code !== 0) throw new Error(r.err || 'git diff failed');
  return r.out;
}

/** Merge the head into the base inside the remote — through a throw-away clone, as a person's merge button would — and record the commit. */
export function merge(file, f, o) {
  const repo = repoOf(f, o);
  const pr = find(f, repo, o._[0]);
  if (pr.state !== 'open') throw new Error(`pull request #${pr.number} is ${pr.state}, not open`);
  const remote = f.repos[repo].remote;
  const head = sha(remote, `refs/heads/${pr.head}`);
  if (!head) throw new Error(`head branch "${pr.head}" is gone from the remote`);
  const strategy = o.squash ? 'squash' : o.rebase ? 'rebase' : 'merge';
  const subject = o.subject && o.subject !== true ? String(o.subject) : strategy === 'merge' ? `Merge pull request #${pr.number} from ${pr.head}` : `${pr.title} (#${pr.number})`;
  const tmp = mkdtempSync(join(tmpdir(), 'hosting-merge-'));
  const run = (args, cwd = tmp) => { const r = spawnSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
  try {
    if (spawnSync('git', ['clone', '-q', '--no-hardlinks', remote, join(tmp, 'w')], { encoding: 'utf8' }).status !== 0) throw new Error('could not read the remote');
    const w = join(tmp, 'w');
    const fail = (why) => { throw new Error(`pull request #${pr.number} is not mergeable: ${why}`); };
    run(['checkout', '-q', pr.base], w);
    if (strategy === 'merge') { if (run(['merge', '--no-ff', '-m', subject, `origin/${pr.head}`], w).code !== 0) fail('the merge commit cannot be created cleanly'); }
    else if (strategy === 'squash') { if (run(['merge', '--squash', `origin/${pr.head}`], w).code !== 0 || run(['commit', '-q', '-m', subject], w).code !== 0) fail('the squash cannot be created cleanly'); }
    else { run(['checkout', '-q', '-B', 'rebased', `origin/${pr.head}`], w); if (run(['rebase', `origin/${pr.base}`], w).code !== 0) fail('the rebase has conflicts'); run(['checkout', '-q', pr.base], w); if (run(['merge', '--ff-only', 'rebased'], w).code !== 0) fail('the base moved'); }
    const pushed = run(['push', '-q', 'origin', `HEAD:refs/heads/${pr.base}`], w);
    if (pushed.code !== 0) throw new Error(`the remote refused the merge: ${pushed.err}`);
    pr.mergeCommit = run(['rev-parse', 'HEAD'], w).out;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  pr.headSha = head; pr.state = 'merged'; pr.mergedAt = nowIso(); pr.updatedAt = pr.mergedAt;
  if (o['delete-branch']) git(remote, ['update-ref', '-d', `refs/heads/${pr.head}`]);
  store(file, f);
  return { number: pr.number, url: urlOf(repo, pr.number), state: 'MERGED', strategy, mergeCommit: pr.mergeCommit };
}

export function close(file, f, o) {
  const repo = repoOf(f, o);
  const pr = find(f, repo, o._[0]);
  if (pr.state !== 'open') throw new Error(`pull request #${pr.number} is ${pr.state}, not open`);
  pr.state = 'closed'; pr.headSha = sha(f.repos[repo].remote, `refs/heads/${pr.head}`) || pr.headSha; pr.updatedAt = nowIso();
  store(file, f);
  return { number: pr.number, url: urlOf(repo, pr.number), state: 'CLOSED' };
}

export const runs = (f, o) => f.runs.filter((r) => (!o.branch || r.branch === o.branch) && (!o.commit || r.commit === o.commit));

function emit(obj, code = 0) {
  process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , area, verb, ...rest] = process.argv;
  const o = flags(area === 'me' ? [verb, ...rest].filter((x) => x !== undefined) : rest);
  try {
    const file = fixturePath(o);
    const f = load(file);
    if (area === 'me') emit({ me: f.me || 'me', repos: Object.keys(f.repos) });
    else if (area === 'pr') {
      const need = () => { if (!o._[0]) throw new Error(`usage: pr ${verb} <number|url> …`); };
      switch (verb) {
        case 'create': emit(create(file, f, o)); break;
        case 'view': need(); emit(view(f, o)); break;
        case 'list': emit(list(f, o)); break;
        case 'comment': need(); emit(comment(file, f, o)); break;
        case 'edit': need(); emit(edit(file, f, o)); break;
        case 'diff': need(); emit(diff(f, o)); break;
        case 'merge': need(); emit(merge(file, f, o)); break;
        case 'close': need(); emit(close(file, f, o)); break;
        case 'checks': need(); find(f, repoOf(f, o), o._[0]); emit({ checks: [], summary: 'no checks reported: the fixture has no pipeline' }); break;
        default: throw new Error('usage: pr create|view|list|comment|edit|diff|merge|close|checks …');
      }
    } else if (area === 'run' && verb === 'list') emit(runs(f, o));
    else throw new Error('usage: hosting.mjs pr <create|view|list|comment|edit|diff|merge|close|checks> … | run list | me   [--claude <.claude> | --file <fixture>]');
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
