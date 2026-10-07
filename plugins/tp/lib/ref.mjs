#!/usr/bin/env node
// ref.mjs — read the reference by reference (context-management.md, rule 10). The reference (README.md and the topic files beside it in
// reference/) is the one place every rule is stated, and it is long; an agent needs the few sections and items a skill names, never a whole file.
//
//   node ref.mjs "<Section>" ["<Section>, <Item>[, <Item>…]" …]
//        -> each section or item under a `## § …` header, in the order asked
//   node ref.mjs list                   -> the table of contents: every heading and the items under it
//
// A section is any `##`/`###`/`####` heading, matched by the text before " — " (case-insensitive: "Definitions",
// "Context management", "Using it", "Commits"). An item inside it is a `- **Name**` bullet (§ Definitions), a `**Name**`
// paragraph (§ Models and budget, "Estimates"; § Unattended runs, "Scheduled runs"), a numbered rule ("rule 8" or "8")
// ("Install, step 2" reads the numbered item too) or a sub-heading ("Using it, Preflight") — with everything up to the next item, so a table or list under it comes too.
// The reference is the plugin's own (reference/, next to lib/: README.md, then every topic file, flowcharts.md excepted — section names are unique
// across them); a first argument that is a .md path reads that one file instead, and
// one that is a folder (the old `<.claude>` form) is ignored. A name that matches nothing prints the contents and exits 1.
// No dependencies.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^(#{2,4}) (.+?)\s*$/;
const BULLET = /^- \*\*(.+?)\*\*/;
const BOLD = /^\*\*([^*]+?)\*\*/;
const RULE = /^(\d+)\. /;

const norm = (s) => String(s).replace(/^§\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').split(' — ')[0].replace(/[.:]\s*$/, '').trim().toLowerCase();

/** The README as sections, each with its items; every block is a [start, end) line range. */
export function parse(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => { const m = HEADING.exec(l); if (m) heads.push({ level: m[1].length, title: m[2], line: i }); });
  const sections = heads.map((h, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].line; break; }
    // the section's own text stops at its first sub-heading; sub-headings are items too
    let own = end;
    for (let j = idx + 1; j < heads.length; j++) if (heads[j].line < end) { own = heads[j].line; break; }
    return { ...h, key: norm(h.title), end, own, items: [] };
  });
  for (const s of sections) {
    const starts = [];
    for (let i = s.line + 1; i < s.own; i++) {
      const l = lines[i];
      let m;
      if ((m = BULLET.exec(l))) starts.push({ key: norm(m[1]), kind: 'bullet', line: i });
      else if ((m = RULE.exec(l))) starts.push({ key: m[1], kind: 'rule', line: i });
      else if ((m = BOLD.exec(l)) && (i === 0 || !lines[i - 1].trim() || RULE.test(lines[i - 1]) || HEADING.test(lines[i - 1]))) starts.push({ key: norm(m[1]), kind: 'paragraph', line: i });
    }
    starts.forEach((it, k) => {
      let end = k + 1 < starts.length ? starts[k + 1].line : s.own;
      if (it.kind === 'bullet') { // a bullet ends at the next top-level bullet or the next item
        for (let i = it.line + 1; i < end; i++) if (/^- /.test(lines[i])) { end = i; break; }
      }
      while (end > it.line + 1 && !lines[end - 1].trim()) end--;
      s.items.push({ ...it, end });
    });
    for (const sub of sections) if (sub.line > s.line && sub.line < s.end) s.items.push({ key: sub.key, kind: 'heading', line: sub.line, end: sub.end });
  }
  return { lines, sections };
}

function find(list, query) {
  const q = norm(query);
  const rule = /^(?:rule\s+|step\s+)?(\d+)$/.exec(q); // a numbered item: "rule 8", "step 2" or "8"
  if (rule) return list.find((x) => x.key === rule[1]) || null;
  return list.find((x) => x.key === q) || list.find((x) => x.key.startsWith(q)) || list.find((x) => x.key.includes(q)) || null;
}

function slice(lines, from, to) {
  let end = to;
  while (end > from && !lines[end - 1].trim()) end--;
  return lines.slice(from, end).join('\n');
}

/** Resolve one query ("Section" or "Section, Item, Item") to printed blocks; throws with the contents on a miss. */
export function lookup(doc, query) {
  const parts = String(query).split(',').map((p) => p.trim()).filter(Boolean);
  const section = find(doc.sections, parts[0]);
  if (!section) throw new Error(`no section matches "${parts[0]}"`);
  if (parts.length === 1) return [{ title: `§ ${section.title}`, text: slice(doc.lines, section.line, section.end) }];
  return parts.slice(1).map((p) => {
    const item = find(section.items, p);
    if (!item) throw new Error(`no item "${p}" in § ${section.title}`);
    const label = item.kind === 'rule' ? `rule ${item.key}` : item.kind === 'heading' ? doc.lines[item.line].replace(HEADING, '$2') : p;
    return { title: `§ ${section.title.split(' — ')[0]}, ${label}`, text: slice(doc.lines, item.line, item.end) };
  });
}

export function contents(doc) {
  return doc.sections.map((s) => `${'  '.repeat(s.level - 2)}${s.title.split(' — ')[0]}${s.items.filter((i) => i.kind !== 'heading').length ? ` — ${s.items.filter((i) => i.kind !== 'heading').map((i) => (i.kind === 'rule' ? `rule ${i.key}` : i.key)).join(' · ')}` : ''}`).join('\n');
}

const REFERENCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference');
/** The reference as one text: README.md first, then every topic file in name order. flowcharts.md is a picture of it, for people. */
export function referenceText(dir = REFERENCE) {
  const files = ['README.md', ...readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'flowcharts.md').sort()];
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n\n');
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  let [first, ...queries] = process.argv.slice(2);
  let file = null; // null: the whole reference
  if (first && /\.md$/i.test(first)) file = first;
  else if (first && isDir(first)) { /* the old <.claude> argument: nothing to select, the README is the plugin's */ }
  else if (first) queries = [first, ...queries];
  if (!queries.length) {
    console.error('usage: ref.mjs "<Section>[, <Item>…]" …  |  ref.mjs list');
    process.exit(2);
  }
  let doc;
  try { doc = parse(file ? readFileSync(file, 'utf8') : referenceText()); } catch (e) { console.error(`cannot read the reference: ${e.message}`); process.exit(2); }
  if (queries.length === 1 && queries[0] === 'list') { console.log(contents(doc)); process.exit(0); }
  const out = [];
  let missed = false;
  for (const q of queries) {
    try { for (const b of lookup(doc, q)) out.push(`## ${b.title}\n\n${b.text}`); } catch (e) { missed = true; out.push(`## ${q}\n\n(${e.message})`); }
  }
  console.log(out.join('\n\n'));
  if (missed) { console.log('\n## contents\n\n' + contents(doc)); process.exit(1); }
}
