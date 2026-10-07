// common.mjs — what every part of the git-hooks script shares: the gate names, the marker a hook this script wrote carries, reading tiers.json's hooks block, git.
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const GATES = ['types', 'lint', 'format', 'tests', 'build'];

export const DEFAULTS = { trust: true, plan: { 'pre-commit': ['lint', 'format'], 'pre-push': ['types', 'tests'] } };

export const HOOK_NAMES = ['pre-commit', 'pre-push', 'commit-msg', 'pre-merge-commit'];

export const MARKER = '# written by the ticket pipeline (lib/hooks.mjs) — edit freely; it is yours';

export const LEGACY_MARKER = '# written by the ticket pipeline (skills/_lib/hooks.mjs) — edit freely; it is yours'; // hooks a project-local install wrote

export const isOurs = (body) => body.includes(MARKER) || body.includes(LEGACY_MARKER);

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };

export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function config(claudeDir) {
  const t = claudeDir ? readJson(join(resolve(String(claudeDir)), 'tiers.json')) || {} : {};
  const h = t.hooks && typeof t.hooks === 'object' ? t.hooks : {};
  const plan = {};
  for (const hook of Object.keys(DEFAULTS.plan)) {
    const given = h.plan && Array.isArray(h.plan[hook]) ? h.plan[hook].filter((g) => GATES.includes(g)) : null;
    plan[hook] = given || DEFAULTS.plan[hook];
  }
  if (h.plan && typeof h.plan === 'object') for (const [hook, list] of Object.entries(h.plan)) if (!plan[hook] && HOOK_NAMES.includes(hook) && Array.isArray(list)) plan[hook] = list.filter((g) => GATES.includes(g));
  const commands = h.commands && typeof h.commands === 'object' ? Object.fromEntries(Object.entries(h.commands).filter(([g, c]) => GATES.includes(g) && typeof c === 'string' && c.trim())) : {};
  return { trust: h.trust !== false, plan, commands };
}

export const git = (repo, args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '').trim() : null; };
