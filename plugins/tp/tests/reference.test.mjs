// The reference (reference/*.md) is one document kept in topic files. Splitting a long README only pays off if every file stays short
// enough to read, the README keeps indexing them, and a pointer to a section names the file the section is really in — the three
// things a later edit loses without anyone noticing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { parse } from '../lib/ref.mjs';

const REFERENCE = join(PLUGIN_ROOT, 'reference');
const MAP = 'flowcharts.md'; // diagrams for people: not part of what `ref.mjs` reads
const INDEX = 'README.md';
const MAX_LINES = 500;
const TOC_AFTER = 100;

const files = readdirSync(REFERENCE).filter((n) => n.endsWith('.md')).sort();
const topics = files.filter((n) => n !== INDEX && n !== MAP);
const read = (n) => readFileSync(join(REFERENCE, n), 'utf8');
const lineCount = (n) => read(n).split('\n').length;

describe('reference/ — every file short enough to read, with its scope up front', () => {
  it(`has no file over ${MAX_LINES} lines`, () => {
    const long = files.filter((n) => lineCount(n) > MAX_LINES).map((n) => `${n} (${lineCount(n)})`);
    assert.deepEqual(long, [], `split ${long.join(', ')} by topic, as the others are`);
  });

  it(`opens every file over ${TOC_AFTER} lines with a Contents line naming each of its sections`, () => {
    for (const n of files.filter((f) => lineCount(f) > TOC_AFTER)) {
      const text = read(n);
      const head = text.split('\n').slice(0, 14).join('\n');
      const toc = /^\*\*Contents\*\* — (.+)$/m.exec(head);
      assert.ok(toc, `${n} has a **Contents** line in its first lines`);
      const { sections } = parse(text);
      for (const s of sections.filter((x) => x.level <= 3)) {
        const title = s.title.replace(/`/g, '').split(' — ')[0];
        assert.ok(toc[1].includes(`[${title}](#`), `${n}: the Contents line names § ${title}`);
      }
    }
  });
});

describe('reference/ — sections are addressed by name, so a name belongs to one file', () => {
  const where = new Map(); // normalised section key -> the file holding it
  const clashes = [];
  for (const n of [INDEX, ...topics]) {
    for (const s of parse(read(n)).sections) {
      if (where.has(s.key) && where.get(s.key) !== n) clashes.push(`"${s.title}" in ${where.get(s.key)} and ${n}`);
      where.set(s.key, n);
    }
  }
  it('has no section name in two files', () => assert.deepEqual(clashes, []));

  it('README.md indexes every topic file, and the sections it lists are the ones the file holds', () => {
    const rows = [...read(INDEX).matchAll(/^\| \[`([\w-]+\.md)`\]\([\w-]+\.md\) \| .+? \| (.+?) \|$/gm)].map((m) => ({ file: m[1], sections: m[2] }));
    assert.deepEqual(rows.map((r) => r.file).sort(), [...topics, MAP].sort(), 'one row per file, flowcharts.md included');
    for (const r of rows.filter((x) => x.file !== MAP)) {
      const holds = parse(read(r.file)).sections.filter((s) => s.level === 2).map((s) => s.title.split(' — ')[0]).sort();
      assert.deepEqual(r.sections.split(',').map((s) => s.trim()).sort(), holds, `${r.file}'s row lists its sections`);
    }
  });
});

describe('pointers to a section name the file the section is in', () => {
  const SECTIONS = new Map(); // key -> file
  for (const n of [INDEX, ...topics]) for (const s of parse(read(n)).sections) SECTIONS.set(s.key, n);
  const keys = [...SECTIONS.keys()].sort((a, b) => b.length - a.length);

  const scan = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (['node_modules', 'results', '.git', 'fixtures'].includes(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|mjs|js|json|sh|yaml)$/.test(n)) scan.push(p);
    }
  };
  walk(PLUGIN_ROOT);

  // `reference/<file>.md` or, inside reference/ and in the diagrams, `<file>.md`; then the section after a § — a pointer may wrap
  // onto the next line, behind a comment marker. A README that belongs to schemas/ or evals/ is another document.
  const FILE = [INDEX, ...topics].map((n) => n.replace('.', '\\.')).join('|');
  const POINTER = new RegExp(`(?:(?<![\\w.-])reference/|(?<![\\w/.-]))(${FILE})\`?[\\s>#*/]*§\\s*(.{0,90})`, 'g');

  it('finds the pointers it checks (the pattern did not rot into matching nothing)', () => {
    const found = pointers().length;
    assert.ok(found > 150, `${found} pointers to the reference`);
  });

  function pointers() {
    const out = [];
    for (const p of scan) {
      const flat = readFileSync(p, 'utf8').replace(/\n[ \t]*(?:\/\/|#|\*|>)?[ \t]*/g, ' ');
      for (const m of flat.matchAll(POINTER)) out.push({ at: p.slice(PLUGIN_ROOT.length + 1), file: m[1], tail: m[2] });
    }
    return out;
  }

  it('every pointer names a section that exists, in the file it names', () => {
    const wrong = [];
    for (const { at, file, tail } of pointers()) {
      const t = tail.replace(/[`*]/g, '').toLowerCase();
      const key = keys.find((k) => t.startsWith(k) && !/[a-z0-9]/.test(t[k.length] ?? ' '));
      if (!key) wrong.push(`${at}: ${file} § ${tail.slice(0, 40)} — no such section`);
      else if (SECTIONS.get(key) !== file) wrong.push(`${at}: ${file} § ${key} — it is in ${SECTIONS.get(key)}`);
    }
    assert.deepEqual(wrong, []);
  });
});
