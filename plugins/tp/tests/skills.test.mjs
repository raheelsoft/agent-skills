// The skills as a set: every rule has exactly one owner, and a parent skill points at its children instead of
// restating them (reference/context-management.md § Context management, rule 3 and § Definitions). These are guards — a rule copied into a
// second skill fails here, which is the only way the "stated once" convention survives a year of edits.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { CATALOGUE } from '../lib/setup.mjs';

const SKILLS = join(PLUGIN_ROOT, 'skills');
const REFERENCE = join(PLUGIN_ROOT, 'reference');
const LIB = join(PLUGIN_ROOT, 'lib');
// The reference is one document spread over topic files (README.md indexes them; flowcharts.md draws them). A rule is "the reference's"
// whichever file holds it, so the owner guards below read README.md and the topic files as one text, under this key.
const REF = 'reference/';
// flowcharts.md is a map of the rules, not a statement of them: it names commands and files on purpose, and its own
// tests below keep every reference honest. It is therefore exempt from the one-owner guard.
const MAP = 'flowcharts.md';
const refFiles = readdirSync(REFERENCE).filter((n) => n.endsWith('.md') && n !== MAP).sort();

/** Every markdown file a person or an agent reads: the skills' (keyed relative to skills/, `plan-day/SKILL.md`), the reference as one (`REF`) and its map. */
function docs() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const n of readdirSync(dir)) {
      if (n.startsWith('_')) continue;
      const p = join(dir, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      if (statSync(p).isDirectory()) { walk(p, rel); continue; }
      if (n.endsWith('.md')) out.push(rel);
    }
  };
  walk(SKILLS, '');
  out.push(REF, MAP);
  return out;
}
/** The files behind a key: the reference's topic files for `REF`, the one file otherwise. */
const pathsOf = (f) => (f === REF ? refFiles.map((n) => join(REFERENCE, n)) : existsSync(join(SKILLS, f)) ? [join(SKILLS, f)] : [join(REFERENCE, f)]);
const ALL = docs();
const text = new Map(ALL.map((f) => [f, pathsOf(f).map((p) => readFileSync(p, 'utf8')).join('\n\n')]));
const holders = (pattern) => ALL.filter((f) => (pattern instanceof RegExp ? pattern.test(text.get(f)) : text.get(f).includes(pattern)));

// rule -> the files allowed to state it. The owner is first; a caller may name the command it runs only where noted.
const OWNERSHIP = [
  { rule: 'the gate record (reuse before running)', pattern: 'gates.mjs result get', owners: [REF, 'verify/SKILL.md'] },
  { rule: 'the gate baseline', pattern: 'gates.mjs base ', owners: ['verify/SKILL.md', REF] },
  { rule: 'gates the hooks own', pattern: 'hooks.mjs cover', owners: [REF, 'verify/SKILL.md'] },
  { rule: 'the gate-command resolver (every ecosystem)', pattern: 'hooks.mjs gates', owners: [REF, 'verify/SKILL.md'] },
  { rule: 'generated code (its callers run it; the rule is the reference\'s)', pattern: 'codegen.mjs status', owners: [REF, 'verify/SKILL.md', 'start-ticket/instructions/branch-and-pull.md'] },
  { rule: 'writing the hooks', pattern: 'hooks.mjs install', owners: ['setup/SKILL.md', REF] },
  { rule: 'the preflight freshness check', pattern: 'doctor.mjs fresh', owners: [REF, 'doctor/SKILL.md'] },
  { rule: 'resolving a blocker (soft-block nuance)', pattern: 'soft-blocking', owners: ['start-ticket/instructions/blocked-check.md'] },
  { rule: 'recording a blocker re-check', pattern: 'state.mjs blockers <workdir>', owners: ['start-ticket/instructions/blocked-check.md', REF] },
  { rule: 'removing a worktree', pattern: 'worktree remove', owners: ['start-ticket/instructions/branch-and-pull.md', 'status/SKILL.md'] },
  { rule: 'creating a worktree', pattern: 'worktree add', owners: ['start-ticket/instructions/branch-and-pull.md', 'review/SKILL.md'] },
  { rule: 'the review loop controller', pattern: 'model.mjs rounds', owners: [REF, 'merge/instructions/review-loop.md', 'review/SKILL.md', 'review/instructions/scope.md'] },
  { rule: 'the compaction rule', pattern: 'model.mjs compact', owners: [REF, 'implement/SKILL.md', 'retro/SKILL.md', 'accept/SKILL.md', 'workflows'] },
  { rule: 'the retry bound (its callers name it; the bound itself is the reference\'s)', pattern: 'model.mjs retry', owners: ['create-pr/SKILL.md', 'implement/SKILL.md', 'plan/SKILL.md', 'release/SKILL.md', 'verify/SKILL.md', REF] },
  { rule: 'the skill catalogue', pattern: 'setup.mjs apply', owners: ['setup/SKILL.md', REF] },
  { rule: 'the tiers a ceiling gives (the interview asks, the script derives, the reference states the rule)', pattern: 'first step up from the smallest', owners: [REF] },
  { rule: 'reading the reference by section', pattern: 'ref.mjs', owners: [REF] },
  { rule: 'showing a stop\'s document before asking', pattern: 'not a place to read', owners: [REF] },
  { rule: 'what an agent costs before it starts', pattern: 'not free before it starts', owners: [REF] },
];

describe('skills — one owner per rule', () => {
  for (const { rule, pattern, owners } of OWNERSHIP) {
    it(`${rule}: only ${owners.join(', ')}`, () => {
      const found = holders(pattern);
      const extra = found.filter((f) => !owners.includes(f) && f !== MAP);
      assert.deepEqual(extra, [], `${JSON.stringify(pattern)} also appears in ${extra.join(', ')} — state it once (owner: ${owners[0]}) and point at it`);
      assert.ok(found.length, `nobody states ${JSON.stringify(pattern)} any more — drop the guard or restore the rule`);
    });
  }
});

describe('skills — a parent points at its children', () => {
  it('every pipeline stage skill states its own Input, Stops and inline=true rating', () => {
    const stages = ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'merge', 'release', 'accept', 'retro', 'verify', 'review'];
    for (const s of stages) {
      const t = text.get(`${s}/SKILL.md`);
      assert.ok(t, `${s}/SKILL.md exists`);
      assert.match(t, /^## Input$/m, `${s} states its input`);
      assert.match(t, /^## Stops$/m, `${s} states its stops`);
      assert.match(t, /`inline=true`/, `${s} names its dedicated agent's rating`);
    }
  });

  it('/tp:run-ticket names each stage by skill and adds no stage instructions of its own', () => {
    const t = text.get('run-ticket/SKILL.md');
    for (const s of ['/tp:start-ticket', '/tp:triage', '/tp:plan', '/tp:implement', '/tp:create-pr', '/tp:merge', '/tp:release', '/tp:accept']) assert.ok(t.includes(s), `run-ticket invokes ${s}`);
    // the orchestrator must not carry a stage's own mechanics: those live in the stage skill
    for (const forbidden of ['git worktree', 'eslint', 'gh pr create', 'acceptanceCriteria', 'lint-staged']) assert.ok(!t.includes(forbidden), `run-ticket should not mention ${forbidden} — that is a stage's own`);
  });

  it('/tp:plan-day and /tp:inbox delegate the blocker re-check instead of restating it', () => {
    for (const f of ['plan-day/SKILL.md', 'inbox/SKILL.md']) {
      const t = text.get(f);
      assert.match(t, /blocked-check\.md`?\s*\n?§ Re-check|blocked-check\.md`\s*\n§ Re-check|blocked-check\.md`\n§ Re-check|blocked-check\.md`? § Re-check/, `${f} points at § Re-check`);
      assert.ok(!/resolved` \(done, cancelled/.test(t), `${f} must not restate how a blocker is classified`);
    }
  });

  it('a skill that can stop says so in its own Stops, and the shared stop order is only in the reference', () => {
    const order = holders('release the lock');
    assert.deepEqual(order, [REF], `the stop order belongs to the reference; also in ${order.filter((f) => f !== REF).join(', ')}`);
  });
});

describe('flowcharts.md — a map that cannot rot quietly', () => {
  const chart = text.get(MAP);
  it('exists, is linked from the reference\'s README, and says it is not for agents', () => {
    assert.ok(chart, 'reference/flowcharts.md exists');
    assert.match(text.get(REF), /\[`flowcharts\.md`\]\(flowcharts\.md\)/, 'reference/README.md links it');
    assert.match(chart, /Agents do not read this file/);
  });

  it('every file it points at exists', () => {
    const refs = [...new Set([...chart.matchAll(/`([\w./-]+\.(?:md|mjs|js))`/g)].map((m) => m[1]))];
    assert.ok(refs.length > 15, `it maps branches to files (${refs.length} found)`);
    const missing = refs.filter((r) => !existsSync(join(SKILLS, r)) && !existsSync(join(REFERENCE, r)) && !existsSync(join(LIB, r)) && !existsSync(join(PLUGIN_ROOT, r)));
    assert.deepEqual(missing, [], `flowcharts.md points at files that do not exist: ${missing.join(', ')}`);
  });

  it('draws every stage of the pipeline and every skill a run can reach', () => {
    for (const s of ['/tp:start-ticket', '/tp:triage', '/tp:plan', '/tp:implement', '/tp:create-pr', '/tp:merge', '/tp:review', '/tp:release', '/tp:accept', '/tp:retro', '/tp:run-ticket', '/tp:plan-day', '/tp:inbox', '/tp:eod', '/tp:doctor', '/tp:setup', '/tp:notify']) {
      assert.ok(chart.includes(s), `flowcharts.md draws ${s}`);
    }
  });

  it('the mermaid blocks are well formed — fences closed, no pipe inside a label', () => {
    const blocks = [...chart.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 6, `${blocks.length} diagrams`);
    assert.equal((chart.match(/```/g) || []).length % 2, 0, 'every fence is closed');
    for (const [i, b] of blocks.entries()) {
      assert.match(b.trim(), /^(flowchart|graph|sequenceDiagram|stateDiagram)/, `diagram ${i + 1} declares its type`);
      for (const line of b.split('\n')) {
        // a pipe inside an edge label ends the label: mermaid then renders an error instead of the diagram
        for (const m of line.matchAll(/\|"([^"]*)"\|/g)) assert.ok(!m[1].includes('|'), `diagram ${i + 1}: a pipe inside an edge label — ${line.trim()}`);
        for (const m of line.matchAll(/\["([^"]*)"\]/g)) assert.ok(!m[1].includes('|'), `diagram ${i + 1}: a pipe inside a node label — ${line.trim()}`);
        assert.equal((line.match(/"/g) || []).length % 2, 0, `diagram ${i + 1}: unbalanced quotes — ${line.trim()}`);
      }
      for (const [open, close] of [['[', ']'], ['{', '}'], ['(', ')']]) {
        const stripped = b.replace(/"[^"]*"/g, '""');
        assert.equal(stripped.split(open).length, stripped.split(close).length, `diagram ${i + 1}: unbalanced ${open}${close} outside labels`);
      }
    }
  });
});

describe('skills — the namespace, so nothing can be confused with another skill', () => {
  // The names these skills carry — status, doctor, review, plan, merge, schedule, setup — are words a runtime, another plugin or a
  // person's own skill already uses. Here they are bare in the folder and the frontmatter, and the plugin's namespace makes every
  // invocation `/tp:<name>`; a reference that loses the namespace invokes something else, silently.
  const NAMES = [...Object.keys(CATALOGUE), 'setup', 'run-ticket-unattended'].sort((a, b) => b.length - a.length);
  const sources = () => [
    ...ALL.map((f) => [f, text.get(f)]),
    ...[LIB, join(PLUGIN_ROOT, 'workflows')].flatMap((d) => readdirSync(d).filter((n) => /\.(mjs|js)$/.test(n)).map((n) => [`${d.slice(PLUGIN_ROOT.length + 1)}/${n}`, readFileSync(join(d, n), 'utf8')])),
  ];

  it('every invocation carries the namespace — none bare, none in the old prefixed form', () => {
    // a slash command, not a path: <.claude>/notify.json and workflows/run-ticket.js are files, not invocations
    const bare = new RegExp(`(^|[^\\w./:-])/(${NAMES.join('|')})(?![\\w:-]|\\.[a-z])`, 'gm');
    const old = new RegExp(`(^|[^\\w./:-])/tp-(${NAMES.join('|')})(?![\\w-])`, 'gm');
    const found = [];
    for (const [f, body] of sources()) {
      for (const m of body.matchAll(bare)) found.push(`${f}: bare ${m[0].trim()}`);
      for (const m of body.matchAll(old)) found.push(`${f}: old prefix ${m[0].trim()}`);
    }
    assert.deepEqual(found, [], `an unqualified invocation invokes another skill or nothing: ${found.join(', ')}`);
  });

  it('every skill folder is a catalogue skill, named by its folder, with no prefix of its own', () => {
    const folders = readdirSync(SKILLS).filter((n) => !n.startsWith('_'));
    assert.deepEqual(folders.sort(), [...Object.keys(CATALOGUE), 'setup'].sort(), 'the plugin ships the catalogue, the interview, and nothing else');
    for (const n of folders) {
      assert.ok(!n.startsWith('tp-') && !n.includes(':'), `${n} carries no prefix: the namespace is the plugin's`);
      assert.match(text.get(`${n}/SKILL.md`), new RegExp(`^name: ${n}$`, 'm'), `${n}'s frontmatter names its folder`);
    }
  });

  it('the unattended workflow is named apart from the skill it mirrors', () => {
    const wf = readFileSync(join(PLUGIN_ROOT, 'workflows', 'run-ticket-unattended.js'), 'utf8');
    const name = /^\s*name: '([^']+)'/m.exec(wf);
    assert.ok(name && !name[1].startsWith('tp-') && !name[1].includes(':'), 'the workflow is named bare too: its plugin\'s namespace is added by the runtime');
    assert.notEqual(name[1], 'run-ticket', 'and it is not the same name as the skill');
  });
});

describe('skills — what a run costs is the number of agents', () => {
  // Measured from this pipeline's own records: a stage agent's floor is 75-130k tokens whatever it does, so the
  // agent count is the bill. Two rules follow from it and both are easy to lose in an edit (reference/context-management.md, rule 9 and rule 12).
  it('rule 12 exists, and every spawned agent is handed it', () => {
    const readme = text.get(REF);
    assert.match(readme, /^12\. \*\*Independent commands in one call\.\*\*/m);
    assert.match(readme, /one\n  call rather than one turn each \(rule 12\)/, 'the spawn template in § Definitions hands it over');
    assert.match(readFileSync(join(PLUGIN_ROOT, 'workflows', 'run-ticket-unattended.js'), 'utf8'), /go in ONE call, not a turn each/, "the unattended runner's stage prompts too");
  });

  it('a list of things is filtered by command before any agent reads one', () => {
    // the shape /tp:start-ticket already had and /tp:plan-day did not: metadata answers the filters, and only what
    // survives them is worth an agent's floor. A morning weighing nineteen tickets to plan five read nineteen.
    const day = text.get('plan-day/SKILL.md');
    assert.match(day, /\*\*Two passes, and the first spawns nothing\*\*/);
    assert.match(day, /for the tickets still standing/, 'the agents come after the filters, not before');
    assert.match(text.get('plan-day/instructions/selection.md'), /in two halves/, 'the row says which half is a command');
    assert.match(text.get('start-ticket/SKILL.md'), /only\s*\n?\s*when a blocker's description must be read/, 'start-ticket keeps the pattern it set');
  });

  it('no skill spawns an agent per item of a list', () => {
    // an agent per follow-up, per defect, per candidate is the shape that multiplies a floor by a list's length
    const offenders = [];
    for (const f of ALL) {
      for (const m of text.get(f).matchAll(/(one|an|a fresh) [\w-]*\s*(?:agent|operator|lookup|fixer|reviewer)s? (?:per|for each) (\w[\w-]*)/g)) {
        // the splits that earn their floor, and the sentences that state the rule itself
        if (/^(tool|repo|ticket|pass|round|job|stage)$/.test(m[2])) continue;
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], `an agent per item of a list costs a floor each (reference/context-management.md, rule 9): ${offenders.join(', ')}`);
  });

  it('implement is the only stage that takes an agent per repo', () => {
    for (const s of ['create-pr', 'merge', 'release']) {
      assert.match(text.get(`${s}/SKILL.md`), /this one agent covers every repo/, `${s} covers every repo in its own agent`);
      assert.match(text.get(`${s}/SKILL.md`), /\*\*The steps below are one repo's\.\*\*/, `${s} says how it loops`);
    }
    assert.match(text.get('implement/SKILL.md'), /one repo per invocation/, 'implement keeps its split');
    assert.match(readFileSync(join(PLUGIN_ROOT, 'workflows', 'run-ticket-unattended.js'), 'utf8'), /const PER_REPO_AGENT = new Set\(\['implement'\]\)/, 'and the runner agrees');
  });
});

describe('skills — the catalogue, the reference and the folders agree', () => {
  it('every skill folder has a SKILL.md with a name matching its folder and a one-sentence description', () => {
    for (const f of ALL) {
      if (!f.endsWith('/SKILL.md')) continue;
      const dir = f.slice(0, -'/SKILL.md'.length);
      const t = text.get(f);
      assert.match(t, new RegExp(`^name: ${dir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'm'), `${f} names its folder`);
      const d = /^description: (.+)$/m.exec(t);
      assert.ok(d, `${f} has a description`);
      assert.ok(d[1].length < 420, `${f}'s description is short (it sits in every agent's prompt): ${d[1].length} chars`);
      assert.match(d[1], /^[A-Z][a-z]+s\b/, `${f}'s description is in the third person (Proves, Takes, Runs …), what the skill does`);
      assert.match(d[1], /\bUse (when|as|after|before|at|to|for|on|once|from)\b/, `${f}'s description says when to use it`);
    }
  });

  // The keys Claude Code documents for a SKILL.md (code.claude.com/docs/en/skills): a misspelt one (`user_invocable`, which every skill
  // here once carried) is silently ignored, and the plugin validator does not look.
  const FRONTMATTER_KEYS = ['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility'];
  // The skills only a person starts. `disable-model-invocation` keeps their description out of every agent's context and refuses them to
  // a subagent or a scheduled task, so it is wrong on anything an orchestrator, a workflow or a scheduled prompt runs.
  const HUMAN_ONLY = ['setup', 'schedule'];
  it('every skill\'s frontmatter uses documented keys only, and `disable-model-invocation` is on the human-only skills and no others', () => {
    for (const f of ALL.filter((x) => x.endsWith('/SKILL.md'))) {
      const dir = f.slice(0, -'/SKILL.md'.length);
      const fm = /^---\n([\s\S]*?)\n---/.exec(text.get(f));
      assert.ok(fm, `${f} has frontmatter`);
      const keys = [...fm[1].matchAll(/^([A-Za-z_-]+):/gm)].map((m) => m[1]);
      assert.deepEqual(keys.filter((k) => !FRONTMATTER_KEYS.includes(k)), [], `${f} uses a key the runtime does not document`);
      assert.equal(/^disable-model-invocation: true$/m.test(fm[1]), HUMAN_ONLY.includes(dir), `${f}: disable-model-invocation belongs on ${HUMAN_ONLY.join(' and ')} only`);
    }
  });

  it('no skill points at a file that does not exist', () => {
    for (const f of ALL) {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      for (const m of text.get(f).matchAll(/`(?:instructions|examples)\/([\w.-]+\.md)`/g)) {
        const base = dir.endsWith('instructions') || dir.endsWith('examples') ? dir.slice(0, dir.lastIndexOf('/')) : dir;
        assert.ok(existsSync(join(SKILLS, base, m[0].includes('examples/') ? 'examples' : 'instructions', m[1])), `${f} points at ${m[0]}`);
      }
      for (const m of text.get(f).matchAll(/`skills\/([\w-]+)\/(?:instructions|examples)\/([\w.-]+\.md)`/g)) {
        assert.ok(existsSync(join(SKILLS, m[1], 'instructions', m[2])) || existsSync(join(SKILLS, m[1], 'examples', m[2])), `${f} points at ${m[0]}`);
      }
    }
  });
});

describe('/tp:setup — the ceiling', () => {
  const setup = () => text.get('setup/SKILL.md');
  it('asks once for the largest model, from the runtime, and writes it through model.mjs', () => {
    assert.match(setup(), /What is\s+the largest model this pipeline may use\?/);
    assert.match(setup(), /never from memory of which\s+models exist/);
    assert.match(setup(), /model\.mjs tiers <\.claude> ceiling=<model>/);
    assert.match(setup(), /model\.mjs pin <\.claude>/);
    assert.match(setup(), /`ceiling=<model>`/);
    assert.doesNotMatch(setup(), /three model\s+names/, 'the three names are no longer asked for');
  });

  it('is the reference\'s interview too: the ceiling, the offer for the session, and where the rule is', () => {
    const readme = text.get(REF);
    assert.match(readme, /asks\s+once for \*\*the largest model the pipeline may use\*\*/);
    assert.match(readme, /\*\*The ceiling — the largest model the pipeline may use\.\*\*/);
    assert.match(readme, /\*\*The session is the runtime's, not the pipeline's\.\*\*/);
    assert.match(readme, /`\/tp:doctor session=<the model this context runs on>`/, 'the entry points hand the doctor their own model');
  });
});

describe('skills — no model is named outside tiers.json', () => {
  it('no skill, script, workflow or office file writes a model name: the ceiling and the ladder are data', () => {
    const files = [
      ...ALL.flatMap(pathsOf),
      ...readdirSync(LIB).filter((f) => f.endsWith('.mjs')).map((f) => join(LIB, f)),
      ...readdirSync(join(PLUGIN_ROOT, 'workflows')).filter((f) => f.endsWith('.js')).map((f) => join(PLUGIN_ROOT, 'workflows', f)),
      ...['app.js', 'serve.mjs', 'index.html'].map((f) => join(PLUGIN_ROOT, 'office', f)).filter(existsSync),
    ];
    assert.ok(files.length > 20, `it scans the pipeline (${files.length} files)`);
    const named = files.filter((f) => /\b(haiku|sonnet|opus|fable)\b/i.test(readFileSync(f, 'utf8')));
    assert.deepEqual(named, [], 'a model name belongs in tiers.json only (reference/models-and-budget.md § Models and budget)');
  });
});
