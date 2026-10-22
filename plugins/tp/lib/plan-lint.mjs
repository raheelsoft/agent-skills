#!/usr/bin/env node
// The mechanical half of the plan check, as a command (lib/contract/plan.mjs has the rules). Run before the checker agent is spawned:
// a plan that fails here goes back to the planner without a model call, and a plan that passes reaches the checker with these rows done.
//
//   node plan-lint.mjs <workdir> [--no-fs] [--record]
//        -> { ok, findings: [{ severity, step, text, source: "lint", rule }], stats, skipped, recorded? }
//        exit 0 no blocking finding, 1 at least one, 2 no plan.md / usage
//   --no-fs    do not look at the worktrees (the structure, counts and wording only)
//   --record   when a finding blocks, write plan-check.json as the round's check (verdict revise, source lint) through the validated writer
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintWorkdir } from './contract/plan.mjs';
import { putArtifact } from './state/put.mjs';

const [, , workdir, ...rest] = process.argv;
if (!workdir || !existsSync(workdir)) { console.error('usage: plan-lint.mjs <workdir> [--no-fs] [--record]'); process.exit(2); }
const result = lintWorkdir(workdir, { fs: !rest.includes('--no-fs') });
if (!result) { console.error(`${join(workdir, 'plan.md')} does not exist — nothing to lint`); process.exit(2); }

if (rest.includes('--record') && !result.ok) {
  let round = 1;
  try { round = (JSON.parse(readFileSync(join(workdir, 'plan-check.json'), 'utf8')).round || 0) + 1; } catch { /* the first check of this plan */ }
  try { putArtifact(workdir, 'plan-check', { verdict: 'revise', round, override: null, findings: result.findings }); result.recorded = true; } catch (e) { console.error(e.message); process.exit(2); }
}
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
