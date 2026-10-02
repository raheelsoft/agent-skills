// The skills as a set: every rule has exactly one owner, and a parent skill points at its children instead of
// restating them (README § Context management, rule 3 and § Definitions). These are guards — a rule copied into a
// second skill fails here, which is the only way the "stated once" convention survives a year of edits.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from './helpers.mjs';
import { CATALOGUE, PREFIX } from '../skills/_lib/setup.mjs';

const SKILLS = join(CLAUDE_DIR, 'skills');
const README = 'README.md';

/** Every markdown file under skills/, by its path relative to skills/. */
function docs() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const n of readdirSync(dir)) {
      if (n.startsWith('_') && n !== '_lib') continue;
      const p = join(dir, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      if (statSync(p).isDirectory()) { if (n !== '_lib') walk(p, rel); continue; }
      if (n.endsWith('.md')) out.push(rel);
    }
  };
  walk(SKILLS, '');
  return out;
}
const ALL = docs();
// flowcharts.md is a map of the rules, not a statement of them: it names commands and files on purpose, and its own
// tests below keep every reference honest. It is therefore exempt from the one-owner guard.
const MAP = 'flowcharts.md';
const text = new Map(ALL.map((f) => [f, readFileSync(join(SKILLS, f), 'utf8')]));
const holders = (pattern) => ALL.filter((f) => (pattern instanceof RegExp ? pattern.test(text.get(f)) : text.get(f).includes(pattern)));

// rule -> the files allowed to state it. The owner is first; a caller may name the command it runs only where noted.
const OWNERSHIP = [
  { rule: 'the gate record (reuse before running)', pattern: 'gates.mjs result get', owners: [README, 'tp-verify/SKILL.md'] },
  { rule: 'the gate baseline', pattern: 'gates.mjs base ', owners: ['tp-verify/SKILL.md', README] },
  { rule: 'gates the hooks own', pattern: 'hooks.mjs cover', owners: [README, 'tp-verify/SKILL.md'] },
  { rule: 'the gate-command resolver (every ecosystem)', pattern: 'hooks.mjs gates', owners: [README, 'tp-verify/SKILL.md'] },
  { rule: 'generated code (its callers run it; the rule is the README\'s)', pattern: 'codegen.mjs status', owners: [README, 'tp-verify/SKILL.md', 'tp-start-ticket/instructions/branch-and-pull.md'] },
  { rule: 'writing the hooks', pattern: 'hooks.mjs install', owners: ['tp-setup/SKILL.md', README] },
  { rule: 'the preflight freshness check', pattern: 'doctor.mjs fresh', owners: [README, 'tp-doctor/SKILL.md'] },
  { rule: 'resolving a blocker (soft-block nuance)', pattern: 'soft-blocking', owners: ['tp-start-ticket/instructions/blocked-check.md'] },
  { rule: 'recording a blocker re-check', pattern: 'state.mjs blockers <workdir>', owners: ['tp-start-ticket/instructions/blocked-check.md', README] },
  { rule: 'removing a worktree', pattern: 'worktree remove', owners: ['tp-start-ticket/instructions/branch-and-pull.md', 'tp-status/SKILL.md'] },
  { rule: 'creating a worktree', pattern: 'worktree add', owners: ['tp-start-ticket/instructions/branch-and-pull.md', 'tp-review/SKILL.md'] },
  { rule: 'the review loop controller', pattern: 'model.mjs rounds', owners: [README, 'tp-merge/instructions/review-loop.md', 'tp-review/SKILL.md', 'tp-review/instructions/scope.md'] },
  { rule: 'the compaction rule', pattern: 'model.mjs compact', owners: [README, 'tp-implement/SKILL.md', 'tp-retro/SKILL.md', 'tp-accept/SKILL.md', 'workflows'] },
  { rule: 'the retry bound (its callers name it; the bound itself is the README\'s)', pattern: 'model.mjs retry', owners: ['tp-create-pr/SKILL.md', 'tp-implement/SKILL.md', 'tp-plan/SKILL.md', 'tp-release/SKILL.md', 'tp-verify/SKILL.md', README] },
  { rule: 'the skill catalogue', pattern: 'setup.mjs apply', owners: ['tp-setup/SKILL.md', README] },
  { rule: 'the tiers a ceiling gives (the interview asks, the script derives, the README states the rule)', pattern: 'first step up from the smallest', owners: [README] },
  { rule: 'reading the README by reference', pattern: 'ref.mjs', owners: [README] },
  { rule: 'showing a stop\'s document before asking', pattern: 'not a place to read', owners: [README] },
  { rule: 'what an agent costs before it starts', pattern: 'not free before it starts', owners: [README] },
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
    const stages = ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'merge', 'release', 'accept', 'retro', 'verify', 'review'].map((n) => PREFIX + n);
    for (const s of stages) {
      const t = text.get(`${s}/SKILL.md`);
      assert.ok(t, `${s}/SKILL.md exists`);
      assert.match(t, /^## Input$/m, `${s} states its input`);
      assert.match(t, /^## Stops$/m, `${s} states its stops`);
      assert.match(t, /`inline=true`/, `${s} names its dedicated agent's rating`);
    }
  });

  it('/tp-run-ticket names each stage by skill and adds no stage instructions of its own', () => {
    const t = text.get('tp-run-ticket/SKILL.md');
    for (const s of ['/tp-start-ticket', '/tp-triage', '/tp-plan', '/tp-implement', '/tp-create-pr', '/tp-merge', '/tp-release', '/tp-accept']) assert.ok(t.includes(s), `run-ticket invokes ${s}`);
    // the orchestrator must not carry a stage's own mechanics: those live in the stage skill
    for (const forbidden of ['git worktree', 'eslint', 'gh pr create', 'acceptanceCriteria', 'lint-staged']) assert.ok(!t.includes(forbidden), `run-ticket should not mention ${forbidden} — that is a stage's own`);
  });

  it('/tp-plan-day and /tp-inbox delegate the blocker re-check instead of restating it', () => {
    for (const f of ['tp-plan-day/SKILL.md', 'tp-inbox/SKILL.md']) {
      const t = text.get(f);
      assert.match(t, /blocked-check\.md`?\s*\n?§ Re-check|blocked-check\.md`\s*\n§ Re-check|blocked-check\.md`\n§ Re-check|blocked-check\.md`? § Re-check/, `${f} points at § Re-check`);
      assert.ok(!/resolved` \(done, cancelled/.test(t), `${f} must not restate how a blocker is classified`);
    }
  });

  it('a skill that can stop says so in its own Stops, and the shared stop order is only in the README', () => {
    const order = holders('release the lock');
    assert.deepEqual(order, [README], `the stop order belongs to the README; also in ${order.filter((f) => f !== README).join(', ')}`);
  });
});

describe('flowcharts.md — a map that cannot rot quietly', () => {
  const chart = text.get(MAP);
  it('exists, is linked from the README, and says it is not for agents', () => {
    assert.ok(chart, 'skills/flowcharts.md exists');
    assert.match(text.get(README), /\[`flowcharts\.md`\]\(flowcharts\.md\)/, 'the README links it');
    assert.match(chart, /Agents do not read this file/);
  });

  it('every file it points at exists', () => {
    const refs = [...new Set([...chart.matchAll(/`([\w./-]+\.(?:md|mjs|js))`/g)].map((m) => m[1]))];
    assert.ok(refs.length > 15, `it maps branches to files (${refs.length} found)`);
    const missing = refs.filter((r) => !existsSync(join(SKILLS, r)) && !existsSync(join(SKILLS, '_lib', r)) && !existsSync(join(CLAUDE_DIR, r)));
    assert.deepEqual(missing, [], `flowcharts.md points at files that do not exist: ${missing.join(', ')}`);
  });

  it('draws every stage of the pipeline and every skill a run can reach', () => {
    for (const s of ['/tp-start-ticket', '/tp-triage', '/tp-plan', '/tp-implement', '/tp-create-pr', '/tp-merge', '/tp-review', '/tp-release', '/tp-accept', '/tp-retro', '/tp-run-ticket', '/tp-plan-day', '/tp-inbox', '/tp-eod', '/tp-doctor', '/tp-setup', '/tp-notify']) {
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

describe('skills — the prefix, so nothing can be confused with another skill', () => {
  // The names these skills would otherwise carry — status, doctor, review, plan, merge, schedule, setup — are words
  // a runtime, a plugin or a person's own skill already uses. Every one of them is <PREFIX><name>, in the folder, in
  // the frontmatter and in every invocation; a reference that loses the prefix invokes something else, silently.
  const BARE = Object.keys(CATALOGUE).map((n) => n.slice(PREFIX.length)).concat('setup').sort((a, b) => b.length - a.length);

  it('every doc names its skills prefixed — no invocation left bare', () => {
    // a slash command, not a path: <.claude>/notify.json and workflows/run-ticket.js are files, not invocations
    const re = new RegExp(`(^|[^\\w./-])/(${BARE.join('|')})(?![\\w-]|\\.[a-z])`, 'gm');
    const bare = [];
    for (const f of ALL) for (const m of text.get(f).matchAll(re)) bare.push(`${f}: ${m[0].trim()}`);
    // and the scripts that print the commands a person types: a bare one there is a command that does not exist
    for (const p of [...readdirSync(join(SKILLS, '_lib')).map((n) => join(SKILLS, '_lib', n)), ...readdirSync(join(CLAUDE_DIR, 'workflows')).map((n) => join(CLAUDE_DIR, 'workflows', n))]) {
      if (!/\.(mjs|js)$/.test(p)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(re)) bare.push(`${p.slice(CLAUDE_DIR.length + 1)}: ${m[0].trim()}`);
    }
    assert.deepEqual(bare, [], `an unprefixed invocation invokes another skill or nothing: ${bare.join(', ')}`);
  });

  it('every skill folder, and nothing else under skills/, carries the prefix', () => {
    const folders = readdirSync(SKILLS).filter((n) => !n.startsWith('_') && !n.endsWith('.md'));
    assert.deepEqual(folders.filter((n) => !n.startsWith(PREFIX)), [], 'a folder without the prefix is a skill that can collide');
    for (const n of folders) assert.match(text.get(`${n}/SKILL.md`), new RegExp(`^name: ${n}$`, 'm'), `${n}'s frontmatter names its folder`);
  });

  it('the unattended workflow is named apart from the skill it mirrors', () => {
    const wf = readFileSync(join(CLAUDE_DIR, 'workflows', 'tp-run-ticket-unattended.js'), 'utf8');
    const name = /^\s*name: '([^']+)'/m.exec(wf);
    assert.ok(name && name[1].startsWith(PREFIX), 'the workflow script carries the prefix too — it is listed beside the skills');
    assert.notEqual(name[1], `${PREFIX}run-ticket`, 'and it is not the same name as the skill');
  });
});

describe('skills — what a run costs is the number of agents', () => {
  // Measured from this pipeline's own records: a stage agent's floor is 75-130k tokens whatever it does, so the
  // agent count is the bill. Two rules follow from it and both are easy to lose in an edit (README rule 9, rule 12).
  it('rule 12 exists, and every spawned agent is handed it', () => {
    const readme = text.get(README);
    assert.match(readme, /^12\. \*\*Independent commands in one call\.\*\*/m);
    assert.match(readme, /one\n  call rather than one turn each \(rule 12\)/, 'the spawn template in § Definitions hands it over');
    assert.match(readFileSync(join(CLAUDE_DIR, 'workflows', 'tp-run-ticket-unattended.js'), 'utf8'), /go in ONE call, not a turn each/, "the unattended runner's stage prompts too");
  });

  it('a list of things is filtered by command before any agent reads one', () => {
    // the shape /tp-start-ticket already had and /tp-plan-day did not: metadata answers the filters, and only what
    // survives them is worth an agent's floor. A morning weighing nineteen tickets to plan five read nineteen.
    const day = text.get('tp-plan-day/SKILL.md');
    assert.match(day, /\*\*Two passes, and the first spawns nothing\*\*/);
    assert.match(day, /for the tickets still standing/, 'the agents come after the filters, not before');
    assert.match(text.get('tp-plan-day/instructions/selection.md'), /in two halves/, 'the row says which half is a command');
    assert.match(text.get('tp-start-ticket/SKILL.md'), /only\s*\n?\s*when a blocker's description must be read/, 'start-ticket keeps the pattern it set');
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
    assert.deepEqual(offenders, [], `an agent per item of a list costs a floor each (README rule 9): ${offenders.join(', ')}`);
  });

  it('implement is the only stage that takes an agent per repo', () => {
    for (const s of ['tp-create-pr', 'tp-merge', 'tp-release']) {
      assert.match(text.get(`${s}/SKILL.md`), /this one agent covers every repo/, `${s} covers every repo in its own agent`);
      assert.match(text.get(`${s}/SKILL.md`), /\*\*The steps below are one repo's\.\*\*/, `${s} says how it loops`);
    }
    assert.match(text.get('tp-implement/SKILL.md'), /one repo per invocation/, 'implement keeps its split');
    assert.match(readFileSync(join(CLAUDE_DIR, 'workflows', 'tp-run-ticket-unattended.js'), 'utf8'), /const PER_REPO_AGENT = new Set\(\['implement'\]\)/, 'and the runner agrees');
  });
});

describe('skills — the catalogue, the README and the folders agree', () => {
  it('every skill folder has a SKILL.md with a name matching its folder and a one-sentence description', () => {
    for (const f of ALL) {
      if (!f.endsWith('/SKILL.md')) continue;
      const dir = f.slice(0, -'/SKILL.md'.length);
      const t = text.get(f);
      assert.match(t, new RegExp(`^name: ${dir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'm'), `${f} names its folder`);
      const d = /^description: (.+)$/m.exec(t);
      assert.ok(d, `${f} has a description`);
      assert.ok(d[1].length < 420, `${f}'s description is one sentence (it sits in every agent's prompt): ${d[1].length} chars`);
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

describe('/tp-setup — the ceiling', () => {
  const setup = () => text.get('tp-setup/SKILL.md');
  it('asks once for the largest model, from the runtime, and writes it through model.mjs', () => {
    assert.match(setup(), /What is\s+the largest model this pipeline may use\?/);
    assert.match(setup(), /never from memory of which\s+models exist/);
    assert.match(setup(), /model\.mjs tiers <\.claude> ceiling=<model>/);
    assert.match(setup(), /model\.mjs pin <\.claude>/);
    assert.match(setup(), /`ceiling=<model>`/);
    assert.doesNotMatch(setup(), /three model\s+names/, 'the three names are no longer asked for');
  });

  it('is the README\'s interview too: the ceiling, the offer for the session, and where the rule is', () => {
    const readme = text.get(README);
    assert.match(readme, /asks\s+once for \*\*the largest model the pipeline may use\*\*/);
    assert.match(readme, /\*\*The ceiling — the largest model the pipeline may use\.\*\*/);
    assert.match(readme, /\*\*The session is the runtime's, not the pipeline's\.\*\*/);
    assert.match(readme, /`\/tp-doctor session=<the model this context runs on>`/, 'the entry points hand the doctor their own model');
  });
});

describe('skills — no model is named outside tiers.json', () => {
  it('no skill, script, workflow or office file writes a model name: the ceiling and the ladder are data', () => {
    const files = [
      ...ALL.map((f) => join(SKILLS, f)),
      ...readdirSync(join(SKILLS, '_lib')).filter((f) => f.endsWith('.mjs')).map((f) => join(SKILLS, '_lib', f)),
      ...readdirSync(join(CLAUDE_DIR, 'workflows')).filter((f) => f.endsWith('.js')).map((f) => join(CLAUDE_DIR, 'workflows', f)),
      ...['app.js', 'serve.mjs', 'index.html'].map((f) => join(CLAUDE_DIR, 'office', f)).filter(existsSync),
    ];
    assert.ok(files.length > 20, `it scans the pipeline (${files.length} files)`);
    const named = files.filter((f) => /\b(haiku|sonnet|opus|fable)\b/i.test(readFileSync(f, 'utf8')));
    assert.deepEqual(named, [], 'a model name belongs in tiers.json only (README § Models and budget)');
  });
});
