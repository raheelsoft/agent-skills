#!/usr/bin/env node
// hooks.mjs — the repo's own git hooks as gate owners (skills/README.md § Verification rules, Gates the hooks own).
// A gate a commit or a push hook already runs costs the pipeline nothing: the hook fails the commit, the agent reads the
// exit code, and no agent, no baseline and no second pass are needed for that gate. This script finds the hooks, says
// which gates they cover and at which scope, and writes Husky-style hooks from the project's own commands.
//
//   node hooks.mjs detect '{ repo }'        -> { manager, hooksPath, hooks: [{ hook, file, commands: [{ raw, gate, scope, via }] }], lintStaged }
//   node hooks.mjs cover '{ repo }'         -> { covered: { <gate>: { hook, command, scope } }, gates: [names], hooks: [..], trust }
//        scope "repo": the hook runs that gate over the whole project (a whole-program check is covered);
//        scope "staged": only over the commit's files (lint and format are covered — they are file-scoped by rule 8 —
//        a type check or a build is not).
//   node hooks.mjs gates '{ repo, claudeDir }'  -> the project's own command per gate, whatever its ecosystem:
//        { types|lint|format|tests|build: { cmd, runner, source, scope, rewrites, check? }, runners, missing }
//        Precedence: tiers.json.hooks.commands (any command, any language) -> a target the project itself defines (a
//        package script, a Makefile/justfile/Taskfile target, a composer/poetry script) -> the ecosystem's own command
//        for the toolchain that is actually configured (cargo, go, ruff/black/mypy/pytest, rubocop/rspec, gradle, mvn,
//        dotnet, mix, swift…) -> nothing, and the gate is `missing`. `/tp:verify` resolves its gate commands the same way.
//   node hooks.mjs plan '{ repo, claudeDir }'   -> what install would write: { hooks: { "pre-commit": [cmd…], "pre-push": [cmd…] }, gates, missing, warnings }
//        from tiers.json.hooks.plan (defaults below) and `gates` above; a gate the project defines no command for is
//        listed in `missing` and never invented. `warnings` names a pre-commit command that REWRITES files (eslint
//        --fix, prettier --write, black, gofmt -w) with no staged-files runner (lint-staged, the pre-commit framework,
//        lefthook): the commit would not contain what it rewrote — the warning names the check-only command instead.
//   node hooks.mjs install '{ repo, claudeDir, dry?, force? }' -> writes .husky/<hook> (+x), sets core.hooksPath when
//        nothing else manages it, and reports { written: [], skipped: [], removed: [], hooksPath, note }. A hook THIS
//        script wrote that the plan no longer includes is removed, so shrinking the plan leaves nothing stale behind;
//        a hook the project wrote is never touched. `dry` returns the file bodies.
//        It never overwrites a hook this script did not write unless `force` (the marker line below).
//
// tiers.json.hooks (defaults): { trust: true, plan: { "pre-commit": ["lint", "format"], "pre-push": ["types", "tests"] },
//                                commands: { "<gate>": "<the project's own command>" } }
//   trust: false -> `cover` reports nothing as covered (an audit run: every gate runs in the pipeline)
//   commands     -> the escape hatch for any toolchain this file does not know: it wins over every detection
// Any OS: the hooks are `#!/bin/sh` with LF endings, which is what git runs on Linux, macOS and Windows (git for
// Windows ships that shell); the exec bit is set where the filesystem has one and skipped where it does not.
// No dependencies.


import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, cover, gatesOf, planHooks, install } from './githooks/index.mjs';

// the library, for whoever imports this file (codegen.mjs, the doctor, the tests): everything but the command line lives in githooks/
export * from './githooks/index.mjs';



function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = () => { if (!rest[0]) throw new Error('missing JSON argument'); return JSON.parse(rest[0]); };
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === 'detect') out(detect(arg()));
    else if (cmd === 'gates') { const a = arg(); out(gatesOf(resolve(String(a.repo || '')), a.claudeDir)); }
    else if (cmd === 'cover') out(cover(arg()));
    else if (cmd === 'plan') out(planHooks(arg()));
    else if (cmd === 'install') out(install(arg()));
    else { console.error("usage: hooks.mjs detect|gates|cover|plan|install '{ repo, claudeDir? }'"); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
