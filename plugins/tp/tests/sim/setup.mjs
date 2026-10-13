#!/usr/bin/env node
// tests/sim/setup.mjs — a throw-away project to exercise the pipeline against the fixture tracker (reference/using.md
// § Using it, Simulation): creates two small git repos (api, web) with a conventions file and a bare remote each, and a
// `.claude` with tiers.json (the models of the file given with --tiers, else placeholders), tracker.json (a copy of the
// fixture, so saves never touch tests/fixtures), office.json, notify.json (silent) and the allowlist. The pipeline itself is
// not copied: the project loads the plugin by path (`claude --plugin-dir <plugin>`). Prints the folder; open a session there.
//
//   node tests/sim/setup.mjs [<dir>] [--tiers <tiers.json>] [low=<m> medium=<m> high=<m>]   (default dir: a fresh temp folder)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..'); // the plugin this bed exercises

export function setup(dir, opts = {}) {
  const root = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'pipeline-sim-'));
  const claude = join(root, '.claude');
  mkdirSync(join(claude, 'work'), { recursive: true });
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repos = {}; const remotes = {};
  for (const [name, kind] of [['api', 'a tiny HTTP API'], ['web', 'a tiny web app']]) {
    const repo = join(root, name); const bare = join(root, `${name}.git`);
    mkdirSync(join(repo, 'src', 'handlers'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), `# ${name} — ${kind}\n\n- Base branch: \`main\`. Branches: \`feat/<slug>\` or \`fix/<slug>\`. Commits: \`feat: …\` / \`fix: …\`.\n- Gates: \`npm run lint\` (\`node --check src/app.js\`) and \`npm test\` (\`node --test\`; there are no tests yet — the gate passes on none).\n- Merge strategy: merge commit; a passing review merges without asking.\n- Reviews do not create tickets.\n- No pipeline runs after a merge (no deploy); no environments.\n- Hosting platform: the fixture in \`.claude/hosting.json\` — run the \`command\` it names (gh's verbs and flags; pull requests are real branches on the bare remote). Plain \`gh\` is not used here.\n- Tracker: the fixture in \`.claude/tracker.json\` (run the \`command\` it names) (team DEMO, project "Demo CRM"); sprints are iterations.\n`);
    writeFileSync(join(repo, 'src', 'app.js'), `// ${name}: the smallest app that can grow\nimport { list } from './handlers/list.js';\nexport const routes = { 'GET /contacts': list };\n`);
    writeFileSync(join(repo, 'src', 'handlers', 'list.js'), `export const contacts = [{ id: 1, name: 'Ann', email: 'ann@example.test' }, { id: 2, name: 'Bob', email: 'bob@example.test' }];\nexport function list(req = {}) { return { status: 200, body: contacts }; }\n`);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { lint: 'node --check src/app.js', test: 'node --test' } }, null, 2) + '\n');
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=sim', '-c', 'user.email=sim@example.test', 'commit', '-q', '-m', 'chore: initial']);
    git(root, ['init', '-q', '--bare', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    repos[name] = repo; remotes[name] = bare;
  }
  const real = opts.tiers && existsSync(opts.tiers) ? JSON.parse(readFileSync(opts.tiers, 'utf8')) : {};
  const models = { low: opts.low || real.low || 'low', medium: opts.medium || real.medium || 'medium', high: opts.high || real.high || 'high' };
  // a ceiling its tiers agree with: the real install's, unless the bed names its own models — then the ladder is those models, smallest first
  const named = ['low', 'medium', 'high'].some((r) => opts[r]);
  const ceiling = !named && real.ceiling && Array.isArray(real.ladder)
    ? { ceiling: real.ceiling, ladder: real.ladder }
    : { ceiling: models.high, ladder: [...new Set([models.low, models.medium, models.high])] };
  writeFileSync(join(claude, 'tiers.json'), JSON.stringify({ ...ceiling, ...models, prices: real.prices || { low: 1, medium: 5, high: 25 }, doctor: { timeoutMs: 30000, checks: [{ name: 'hosting CLI', run: [process.execPath, join(PLUGIN_ROOT, 'lib', 'hosting.mjs'), 'me', '--claude', claude], expect: 'dev' }] } }, null, 2) + '\n');
  const fixture = join(claude, 'tracker.fixture.json');
  writeFileSync(fixture, readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'tracker.json'), 'utf8'));
  writeFileSync(join(claude, 'tracker.json'), JSON.stringify({ kind: 'fixture', path: fixture, command: `node ${join(PLUGIN_ROOT, 'lib', 'tracker.mjs')}` }, null, 2) + '\n');
  const hosting = join(claude, 'hosting.fixture.json');
  writeFileSync(hosting, JSON.stringify({ me: 'dev', repos: Object.fromEntries(Object.entries(remotes).map(([n, remote]) => [n, { remote, defaultBranch: 'main' }])), prs: [], runs: [] }, null, 2) + '\n');
  writeFileSync(join(claude, 'hosting.json'), JSON.stringify({ kind: 'fixture', path: hosting, command: `node ${join(PLUGIN_ROOT, 'lib', 'hosting.mjs')}` }, null, 2) + '\n');
  writeFileSync(join(claude, 'office.json'), JSON.stringify({ team: 'Demo CRM', projects: ['api', 'web'], poll: 2500, linger: 120 }, null, 2) + '\n');
  writeFileSync(join(claude, 'notify.json'), JSON.stringify({ tool: null, target: null, project: 'demo', levels: ['stop', 'done', 'error'], setAt: new Date().toISOString() }, null, 2) + '\n');
  const allow = [`Edit(//${claude.replace(/^\/+/, '')}/worktrees/**)`, `Bash(node ${PLUGIN_ROOT}/lib/*)`, `Bash(node ${PLUGIN_ROOT}/office/*)`, 'Bash(node --test *)', 'Bash(node --check *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git fetch*)', 'Bash(git rev-parse*)', 'Bash(git merge-base*)', 'Bash(git branch*)', 'Bash(git worktree *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git merge *)', 'Bash(git push *)'];
  writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ permissions: { allow } }, null, 2) + '\n');
  writeFileSync(join(claude, '.gitignore'), 'work/\nworktrees/\n');
  return { root, claude, repos, fixture, models, plugin: PLUGIN_ROOT };
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (const a of args) { const m = /^(low|medium|high)=(.+)$/.exec(a); if (m) opts[m[1]] = m[2]; }
  const tiersAt = args.indexOf('--tiers');
  if (tiersAt >= 0) opts.tiers = resolve(args[tiersAt + 1]);
  const dir = args.find((a, i) => !a.startsWith('--') && !/^(low|medium|high)=/.test(a) && args[i - 1] !== '--tiers');
  const r = setup(dir, opts);
  console.log(`simulation bed: ${r.root}
  .claude/        the project's configuration (tracker and hosting platform: files in it); the pipeline is the plugin at ${r.plugin}
  api/  web/      two repos on main, each with a bare remote (${r.root}/<name>.git)
  models          ${Object.entries(r.models).map(([k, v]) => `${k}=${v}`).join(' ')}
next: cd ${r.root} && claude --plugin-dir ${r.plugin}   and try
  /tp:doctor
  /tp:plan-day date=2026-09-21 dry=true          (sprint 4 from the fixture)
  /tp:run-ticket DEMO-4                           (a direct bug fix, pickup to acceptance — no tracker or hosting account needed)
  node ${r.plugin}/office/serve.mjs --work ${r.claude}/work     (the office for this bed)
pull requests are real branches on the bare remotes, opened and merged by lib/hosting.mjs (reference/using.md § Using it, Simulation).`);
}
