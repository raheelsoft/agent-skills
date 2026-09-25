#!/usr/bin/env node
// tests/sim/setup.mjs — a throw-away install to exercise the pipeline against the fixture tracker (skills/README.md
// § Using it, Simulation): copies the skills, workflows, tests and office into <dir>/.claude, creates two small git
// repos (api, web) with a conventions file and a bare remote each, writes tiers.json (the real install's models when
// present), tracker.json (a copy of the fixture, so saves never touch tests/fixtures), office.json, notify.json
// (silent) and the allowlist. Prints the folder; open a session there and run the skills.
//
//   node tests/sim/setup.mjs [<dir>] [--models low=<m> medium=<m> high=<m>]   (default dir: a fresh temp folder)
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..'); // the real <.claude>

export function setup(dir, opts = {}) {
  const root = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'pipeline-sim-'));
  const claude = join(root, '.claude');
  mkdirSync(claude, { recursive: true });
  for (const d of ['skills', 'workflows', 'tests']) cpSync(join(SRC, d), join(claude, d), { recursive: true });
  cpSync(join(SRC, 'office'), join(claude, 'office'), { recursive: true, filter: (p) => !p.includes(`${join('office', 'electron', 'node_modules')}`) });
  mkdirSync(join(claude, 'work'), { recursive: true });
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repos = {};
  for (const [name, kind] of [['api', 'a tiny HTTP API'], ['web', 'a tiny web app']]) {
    const repo = join(root, name); const bare = join(root, `${name}.git`);
    mkdirSync(join(repo, 'src', 'handlers'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), `# ${name} — ${kind}\n\n- Base branch: \`main\`. Branches: \`feat/<slug>\` or \`fix/<slug>\`. Commits: \`feat: …\` / \`fix: …\`.\n- Gates: \`node --check src/app.js\` and \`node --test\` (there are no tests yet — the gate passes on none).\n- Merge strategy: merge commit; a passing review merges without asking.\n- Reviews do not create tickets.\n- No pipeline runs after a merge (no deploy); no environments.\n- Tracker: the fixture in \`.claude/tracker.json\` (team DEMO, project "Demo CRM"); sprints are iterations.\n`);
    writeFileSync(join(repo, 'src', 'app.js'), `// ${name}: the smallest app that can grow\nimport { list } from './handlers/list.js';\nexport const routes = { 'GET /contacts': list };\n`);
    writeFileSync(join(repo, 'src', 'handlers', 'list.js'), `export const contacts = [{ id: 1, name: 'Ann', email: 'ann@example.test' }, { id: 2, name: 'Bob', email: 'bob@example.test' }];\nexport function list(req = {}) { return { status: 200, body: contacts }; }\n`);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { check: 'node --check src/app.js', test: 'node --test' } }, null, 2) + '\n');
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=sim', '-c', 'user.email=sim@example.test', 'commit', '-q', '-m', 'chore: initial']);
    git(root, ['init', '-q', '--bare', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    repos[name] = repo;
  }
  const real = existsSync(join(SRC, 'tiers.json')) ? JSON.parse(readFileSync(join(SRC, 'tiers.json'), 'utf8')) : {};
  const models = { low: opts.low || real.low || 'low', medium: opts.medium || real.medium || 'medium', high: opts.high || real.high || 'high' };
  writeFileSync(join(claude, 'tiers.json'), JSON.stringify({ ...models, prices: real.prices || { low: 1, medium: 5, high: 25 }, doctor: { checks: [] } }, null, 2) + '\n');
  const fixture = join(claude, 'tracker.fixture.json');
  writeFileSync(fixture, readFileSync(join(SRC, 'tests', 'fixtures', 'tracker.json'), 'utf8'));
  writeFileSync(join(claude, 'tracker.json'), JSON.stringify({ kind: 'fixture', path: fixture }, null, 2) + '\n');
  writeFileSync(join(claude, 'office.json'), JSON.stringify({ team: 'Demo CRM', projects: ['api', 'web'], poll: 2500, linger: 120 }, null, 2) + '\n');
  writeFileSync(join(claude, 'notify.json'), JSON.stringify({ tool: null, target: null, project: 'demo', levels: ['stop', 'done', 'error'], setAt: new Date().toISOString() }, null, 2) + '\n');
  const allow = [`Bash(node ${claude}/skills/_lib/*)`, `Bash(node ${claude}/office/*)`, 'Bash(node --test *)', 'Bash(node --check *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git fetch*)', 'Bash(git rev-parse*)', 'Bash(git merge-base*)', 'Bash(git branch*)', 'Bash(git worktree *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git merge *)', 'Bash(git push *)'];
  writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ permissions: { allow } }, null, 2) + '\n');
  writeFileSync(join(claude, '.gitignore'), 'work/\n');
  return { root, claude, repos, fixture, models };
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (const a of args) { const m = /^(low|medium|high)=(.+)$/.exec(a); if (m) opts[m[1]] = m[2]; }
  const dir = args.find((a) => !a.startsWith('--') && !/^(low|medium|high)=/.test(a));
  const r = setup(dir, opts);
  console.log(`simulation bed: ${r.root}
  .claude/        the pipeline (tracker: ${r.fixture})
  api/  web/      two repos on main, each with a bare remote (${r.root}/<name>.git)
  models          ${Object.entries(r.models).map(([k, v]) => `${k}=${v}`).join(' ')}
next: open a session in ${r.root} and try
  /tp-doctor
  /tp-plan-day date=2026-09-21 dry=true          (sprint 4 from the fixture)
  /tp-run-ticket DEMO-4 until=implement           (a direct bug fix, no tracker or hosting account needed)
  node .claude/office/serve.mjs                (the office for this bed)
/tp-create-pr onwards needs a real hosting platform — the bed stops at the push (README § Using it, Simulation).`);
}
