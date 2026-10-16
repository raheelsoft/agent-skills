#!/usr/bin/env node
// branchfacts.mjs — what /tp:create-pr, /tp:implement and /tp:merge each ask git about a branch before they act, in one call on the developer's machine:
// the branch and whether it is the base, uncommitted changes, the commits ahead of the base and how far the base moved on, the diff size, the remote and
// whether the branch is already pushed. Seven or eight separate `git` turns become one, and the facts cannot be misread out of a long output.
//
//   node branchfacts.mjs '{ "repo": "<worktree>", "base": "main" }' [--fetch]
//   { repo, branch, onBase, head, base: { ref, sha }, remote: { name, url } | null, fetch?: { ok, error? }, ahead, behind, commits: [{ sha, subject }],
//     dirty: [{ status, path }], diff: { files, additions, deletions }, pushed: { exists, sha, upToDate } }
// `base` is a branch name: the remote's copy (`origin/main`) is used when it exists, the local one otherwise. `--fetch` updates the remote first and reports
// whether that worked (a failed fetch leaves the last known remote state and says so). No dependencies beyond git.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
}

/** The remote the branch is pushed to: `origin`, else the only one, else none. */
function remoteOf(repo) {
  const names = (git(repo, ['remote']) || '').split('\n').filter(Boolean);
  const name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null;
  return name ? { name, url: git(repo, ['remote', 'get-url', name]) || '' } : null;
}

export function branchfacts({ repo, base, fetch = false }) {
  if (!repo || !base) throw new Error('usage: branchfacts.mjs \'{ "repo": "<worktree>", "base": "<branch>" }\' [--fetch]');
  if (git(repo, ['rev-parse', '--git-dir']) === null) throw new Error(`${repo} is not a git checkout`);
  const remote = remoteOf(repo);
  const out = { repo };
  if (fetch && remote) {
    try { execFileSync('git', ['-C', repo, 'fetch', '--quiet', remote.name], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); out.fetch = { ok: true }; } catch (e) { out.fetch = { ok: false, error: String(e.stderr || e.message).trim().split('\n')[0] }; }
  }
  const bare = base.replace(/^refs\/heads\//, '').replace(new RegExp(`^${remote?.name || 'origin'}/`), '');
  const ref = remote && git(repo, ['rev-parse', '--verify', '--quiet', `${remote.name}/${bare}`]) ? `${remote.name}/${bare}` : bare;
  const baseSha = git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  if (!baseSha) throw new Error(`base ${base} is not a branch of ${repo}`);
  const branch = git(repo, ['branch', '--show-current']) || '';
  const [behind, ahead] = (git(repo, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]) || '0\t0').split(/\s+/).map(Number);
  const stat = (git(repo, ['diff', '--numstat', `${ref}...HEAD`]) || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const pushedSha = remote && branch ? git(repo, ['rev-parse', '--verify', '--quiet', `${remote.name}/${branch}`]) : null;
  const head = git(repo, ['rev-parse', 'HEAD']);
  return {
    ...out, branch, onBase: branch === bare, head, base: { ref, sha: baseSha }, remote, ahead, behind,
    commits: (git(repo, ['log', '--format=%H%x09%s', `${ref}..HEAD`]) || '').split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; }),
    dirty: (git(repo, ['status', '--porcelain']) || '').split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
    diff: { files: stat.length, additions: stat.reduce((n, c) => n + (Number(c[0]) || 0), 0), deletions: stat.reduce((n, c) => n + (Number(c[1]) || 0), 0) },
    pushed: { exists: Boolean(pushedSha), sha: pushedSha, upToDate: Boolean(pushedSha) && pushedSha === head },
  };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const input = JSON.parse(args.find((a) => a.trim().startsWith('{')) || '{}');
    console.log(JSON.stringify(branchfacts({ ...input, fetch: input.fetch || args.includes('--fetch') }), null, 2));
  } catch (e) {
    console.error(String(e.message || e).split('\n')[0]);
    process.exit(2);
  }
}
