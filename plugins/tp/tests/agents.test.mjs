// The plugin's role agents (agents/*.md): what a definition must and must not say, and that the skills spawn them by type.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { ROLES } from '../hooks/roles.mjs';
import { CONTRACTS } from '../hooks/handlers/subagent-stop.mjs';
import { referenceText } from '../lib/ref.mjs';

const DIR = join(PLUGIN_ROOT, 'agents');
const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
const parse = (f) => {
  const text = readFileSync(join(DIR, f), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${f} has frontmatter`);
  const front = Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return { front, body: m[2].trim() };
};
const skill = (name) => readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');

describe('agents/ — the definitions', () => {
  const verifiers = Object.keys(ROLES).map((r) => `${r.replace('tp:', '')}.md`);
  it('there is a definition for each role the hooks know, and no other: the verifiers are held to their jobs, every agent to its contract', () => {
    assert.deepEqual(files.map((f) => `tp:${f.replace(/\.md$/, '')}`), Object.keys(CONTRACTS).sort());
    for (const v of verifiers) assert.ok(files.includes(v), v);
  });

  for (const f of files) {
    it(`${f}: a name that is the file's, a description that says what it is and who spawns it, tools taken away, no model`, () => {
      const { front, body } = parse(f);
      assert.equal(front.name, f.replace(/\.md$/, ''));
      assert.match(front.description, /^[A-Z]/);
      assert.match(front.description, /Spawned by \/tp:[a-z-]+/, 'says who spawns it');
      assert.match(front.description, /not for general use/);
      assert.ok(front.description.length <= 400);
      for (const key of ['model', 'effort', 'tools', 'permissionMode', 'hooks', 'mcpServers']) assert.equal(key in front, false, `${key} is not set: the spawner's pick wins, and a plugin agent cannot widen what its hooks hold it to`);
      if (verifiers.includes(f)) for (const tool of ['Agent', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(front.disallowedTools.split(',').map((s) => s.trim()).includes(tool), `${tool} is taken away`);
      assert.ok(body.split('\n').length <= 20, 'a role contract, not a manual');
    });

    it(`${f}: says what it does to the repositories, and closes with the output contract`, () => {
      const { body } = parse(f);
      if (verifiers.includes(f)) assert.match(body, /change[s]? nothing in (any|the) repositor/i);
      else assert.match(body, /commit/i, 'the implementer says its work is committed');
      assert.match(body, /`complexity: as rated \| higher — <reason>`/);
      assert.match(body, /`continue: no \| <checkpoint path>`/);
      assert.match(body, /hook/i, 'names the hook that enforces what it says');
      assert.doesNotMatch(body, /\$\{CLAUDE_|<lib>|\/Users\//, 'no path: its task prompt has them');
    });
  }
});

describe('the skills spawn them by type', () => {
  it('/tp:plan spawns its checker as tp:plan-checker', () => assert.match(skill('plan'), /agent of type `tp:plan-checker`/));
  it('/tp:create-pr spawns its diff validator as tp:diff-validator', () => assert.match(skill('create-pr'), /agent of type `tp:diff-validator`/));
  it('/tp:merge hands the review to a tp:reviewer', () => assert.match(skill('merge'), /of type `tp:reviewer`/));
  it('the reference says which type is the dedicated agent of /tp:implement', () => assert.match(referenceText(), /`\/tp:implement`'s is\s+`tp:implementer`/));
});
