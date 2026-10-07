// plan.mjs — the mechanical half of the plan check. plan.md follows a template (skills/plan/instructions/plan-template.md); whether it has the
// sections, counts that agree with plan.json, every file a step edits actually there, every `path:line` it cites real, no template placeholder
// left in it — none of that needs a model. This reads the plan and the worktrees and returns findings in plan-check.json's shape, so the checker
// agent is spent only on what takes judgment (does the cited code say what the plan claims, does the approach fit the conventions).
//
// parsePlan(text)               -> the plan as data: header, sections, steps (files, fields, commit), criteria, open questions, citations
// lintPlan(plan, ctx)           -> { ok, findings: [{ severity, step, text, source: 'lint', rule }], stats, skipped }
//   ctx: { ticket?, planJson?, repos?: [{ name, worktree, path }], projectRoot?, fs?: true }  — without a worktree the file rules are skipped, and named in `skipped`
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const SECTIONS = ['Goal', 'Current behaviour', 'Approach', 'Steps', 'Verification', 'Risks and rollback', 'Open questions', 'Out of scope'];
/** What an implementer cannot work without; a missing section among the others is worth a line, not a rework. */
const ESSENTIAL = new Set(['Goal', 'Steps', 'Verification']);
export const FLAGS = ['none', 'data-model', 'access-control', 'public-contract', 'cross-repo', 'irreversible'];
const STEP_FIELDS = ['Files', 'Change', 'Pattern', 'Checkpoint', 'Commit'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', 'out', '.cache']);
const MAX_INDEXED = 200000;

const ONLY_NONE = /^(none|n\/a|nothing|—|–|-)\.?$/i;
const withoutCode = (line) => line.replace(/`[^`]*`/g, '``');

/** The plan as data. Never throws: a plan that does not follow the template parses into whatever it has, and the rules say what is missing. */
export function parsePlan(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const fenced = [];
  let open = false;
  for (const l of lines) { if (/^\s*(```|~~~)/.test(l)) { open = !open; fenced.push(true); } else fenced.push(open); }

  const titleLine = lines.findIndex((l, i) => !fenced[i] && /^# /.test(l));
  const title = titleLine >= 0 ? /^#\s+Plan\s*[—–-]\s*([^\s:]+)\s*:\s*(.*)$/.exec(lines[titleLine]) : null;

  // sections: `## Name` outside code, body up to the next one
  const heads = [];
  lines.forEach((l, i) => { const m = !fenced[i] && /^##\s+(.+?)\s*$/.exec(l); if (m) heads.push({ name: m[1], line: i }); });
  const sections = {};
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    sections[h.name.toLowerCase()] = { name: h.name, line: h.line + 1, lines: lines.slice(h.line + 1, end), offset: h.line + 1, fenced: fenced.slice(h.line + 1, end) };
  });
  const body = (name) => (sections[name.toLowerCase()]?.lines || []).join('\n').trim();

  // header: the lines between the title and the first section
  const headEnd = heads.length ? heads[0].line : lines.length;
  const headLines = lines.slice(titleLine + 1, headEnd);
  const field = (key) => {
    const i = headLines.findIndex((l) => new RegExp(`^${key}\\s*:`, 'i').test(l));
    if (i < 0) return null;
    const first = headLines[i].replace(new RegExp(`^${key}\\s*:\\s*`, 'i'), '');
    const rest = [];
    for (let j = i + 1; j < headLines.length && headLines[j].trim() && !/^[a-z][a-z ]*:/i.test(headLines[j]); j++) rest.push(headLines[j].trim());
    return [first, ...rest].filter(Boolean);
  };
  const status = field('status');
  const flagsRaw = field('risk flags');
  const repos = field('repos');
  const header = {
    id: title ? title[1] : null,
    title: title ? title[2].trim() : null,
    status: status ? status[0].trim().replace(/`/g, '') : null,
    flags: flagsRaw ? flagsRaw.join(' ').split(/[|,]/).map((f) => f.replace(/[`\s]+/g, ' ').trim().replace(/\s*\(.*$/, '')).filter(Boolean) : null,
    repos: repos ? repos.filter((r) => r !== '-') : null,
  };

  // goal: the first numbered list is the acceptance criteria
  const goal = sections.goal ? sections.goal.lines.filter((l, i) => !sections.goal.fenced[i]) : [];
  const criteria = [];
  let started = false;
  for (const l of goal) {
    const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l);
    if (m) { started = true; criteria.push({ n: Number(m[1]), text: m[2].trim() }); } else if (started && !l.trim()) break; else if (started && /^\S/.test(l)) break;
  }

  // steps: `### Step <n> — <name>` under Steps, each with its bullet fields
  const steps = [];
  const stepsSection = sections.steps;
  if (stepsSection) {
    const idx = [];
    stepsSection.lines.forEach((l, i) => { const m = !stepsSection.fenced[i] && /^###\s+Step\s+(\d+)\b\s*[—–:-]?\s*(.*)$/.exec(l); if (m) idx.push({ i, n: Number(m[1]), name: m[2].trim() }); });
    idx.forEach((h, k) => {
      const end = k + 1 < idx.length ? idx[k + 1].i : stepsSection.lines.length;
      const block = stepsSection.lines.slice(h.i + 1, end);
      const blockFenced = stepsSection.fenced.slice(h.i + 1, end);
      const fields = {};
      let current = null;
      block.forEach((l, j) => {
        const m = !blockFenced[j] && /^- (Files|Change|Pattern|Checkpoint|Commit)\b[^:\n]*:\s*(.*)$/i.exec(l);
        if (m) { current = STEP_FIELDS.find((f) => f.toLowerCase() === m[1].toLowerCase()); fields[current] = { text: m[2], lines: [m[2]], line: stepsSection.offset + h.i + 1 + j + 1 }; } else if (current && (blockFenced[j] || /^\s+\S/.test(l) || (l.trim() && !/^#{1,6}\s/.test(l) && !/^- /.test(l)))) { fields[current].lines.push(l); fields[current].text += `\n${l}`; }
      });
      steps.push({ n: h.n, name: h.name, line: stepsSection.offset + h.i + 1, fields, files: filesOf(fields.Files?.text), commit: commitOf(fields.Commit?.text) });
    });
  }

  // open questions: numbered items, or none
  const oq = sections['open questions'];
  const oqText = oq ? oq.lines.join('\n').trim() : '';
  const questions = [];
  if (oq && oqText && !ONLY_NONE.test(oqText)) {
    let cur = null;
    for (const l of oq.lines) {
      const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l);
      if (m) { cur = { n: Number(m[1]), text: m[2] }; questions.push(cur); } else if (cur && l.trim()) cur.text += ` ${l.trim()}`;
    }
  }

  // citations: `path/to/file.ext:12` or `:12-30`, in § Current behaviour and in a step's Pattern — never inside a code fence
  const citations = [];
  const cite = (line, where, step) => {
    for (const m of line.matchAll(/`([^`\s:]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:[-–](\d+))?/g)) citations.push({ path: m[1], line: Number(m[2]), to: m[3] ? Number(m[3]) : null, where, step });
  };
  const cb = sections['current behaviour'];
  if (cb) cb.lines.forEach((l, i) => { if (!cb.fenced[i]) cite(l, 'Current behaviour', null); });
  for (const s of steps) if (s.fields.Pattern) cite(s.fields.Pattern.text, `Step ${s.n} pattern`, s.n);

  return { header, sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, { name: v.name, line: v.line, empty: !v.lines.join('').trim() }])), criteria, steps, questions, citations, openQuestionsText: oqText, rawLines: lines, fenced, bodyOf: body };
}

/** `Files:` → [{ path, kind: 'new'|'edit'|null }] — only what is in backticks; `none` or `none in the repo` is no files. */
function filesOf(text) {
  if (text === undefined) return null;
  const out = [];
  for (const m of text.matchAll(/`([^`]+)`(?:\s*\(([^)]*)\))?/g)) {
    const kind = /^\s*(new|edit)\b/i.exec(m[2] || '');
    out.push({ path: m[1].trim(), kind: kind ? kind[1].toLowerCase() : null });
  }
  return out;
}

/** `Commit:` → { yes, folded: n|null, text } */
function commitOf(text) {
  if (text === undefined) return null;
  const t = text.trim();
  const folded = /folded\s+into\s+step\s+(\d+)/i.exec(t);
  return { yes: /^yes\b/i.test(t), no: /^no\b/i.test(t), folded: folded ? Number(folded[1]) : null, text: t };
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Where a plan's relative path can be: each repo's worktree (also without a leading repo-name folder), the folder around the repos, the project root. */
function candidates(rel, ctx) {
  if (isAbsolute(rel)) return [rel];
  const out = [];
  for (const r of ctx.repos) {
    if (r.worktree) {
      out.push(join(r.worktree, rel));
      if (rel.startsWith(`${r.name}/`)) out.push(join(r.worktree, rel.slice(r.name.length + 1)));
    }
    if (r.path && isAbsolute(r.path)) out.push(join(dirname(r.path), rel));
  }
  if (ctx.projectRoot) out.push(join(ctx.projectRoot, rel));
  return out;
}

// A plan often names a file by the tail of its path after the first mention (`dto/update-leave-type.dto.ts`, `leads.service.ts`): so a path
// that is in no worktree as written still counts when some file ends with it. One walk of each worktree, skipping what is not source.
const indexes = new Map();
function indexOf(root) {
  if (indexes.has(root)) return indexes.get(root);
  const byName = new Map();
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen > MAX_INDEXED) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); } else { seen++; const k = e.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(join(dir, e.name)); }
    }
  };
  walk(root);
  indexes.set(root, byName);
  return byName;
}
/** Files in the worktrees whose path ends with `rel` (a bare name matches by name alone). */
function bySuffix(rel, ctx) {
  const tail = rel.replace(/^\.?\//, '');
  const out = [];
  for (const r of ctx.repos) {
    if (!r.worktree || !isDir(r.worktree)) continue;
    for (const p of indexOf(r.worktree).get(basename(tail)) || []) if (p.endsWith(`/${tail}`)) out.push(p);
  }
  return out;
}

const lineCounts = new Map();
const linesIn = (file) => {
  if (!lineCounts.has(file)) {
    let n = null;
    try { if (statSync(file).size <= MAX_FILE_BYTES) n = readFileSync(file, 'utf8').split('\n').length; } catch { /* unreadable: no line check */ }
    lineCounts.set(file, n);
  }
  return lineCounts.get(file);
};

/** Run every rule. `ctx` as in the header; a missing ctx piece skips the rule that needs it and says so. */
export function lintPlan(plan, ctx = {}) {
  const findings = [];
  const skipped = [];
  const add = (severity, step, rule, text) => findings.push({ severity, step: step ?? '—', text, source: 'lint', rule });
  const block = (step, rule, text) => add('blocking', step, rule, text);
  const planJson = ctx.planJson || null;
  const repos = (ctx.repos || []).filter((r) => r && !r.discarded);
  const usable = (ctx.fs !== false) && repos.some((r) => r.worktree && isDir(r.worktree));
  lineCounts.clear();
  indexes.clear();

  // 1. sections
  for (const name of SECTIONS) {
    const s = plan.sections[name.toLowerCase()];
    if (!s) add(ESSENTIAL.has(name) ? 'blocking' : 'advisory', '—', 'sections', `§ ${name} is missing — the template has it (skills/plan/instructions/plan-template.md)`);
    else if (s.empty && ESSENTIAL.has(name)) block('—', 'sections', `§ ${name} is empty`);
  }

  // 2. header
  const h = plan.header;
  const ticketId = ctx.ticket?.id;
  if (!h.id) block('—', 'header', 'the title line is not "# Plan — <ticket id>: <title>"');
  else if (ticketId && h.id !== ticketId) block('—', 'header', `the title names ${h.id}, the ticket is ${ticketId}`);
  if (!['ready', 'open-questions'].includes(h.status)) block('—', 'header', `"status:" is ${h.status === null ? 'missing' : `"${h.status}"`}; it is ready or open-questions`);
  if (h.flags === null) block('—', 'header', '"risk flags:" is missing (none, or any of data-model, access-control, public-contract, cross-repo, irreversible)');
  else for (const f of h.flags) if (!FLAGS.includes(f)) block('—', 'header', `risk flag "${f}" is not one of ${FLAGS.join(', ')}`);
  if (h.repos === null) block('—', 'header', '"repos:" is missing');
  const flags = (h.flags || []).filter((f) => f !== 'none');
  if (h.repos && h.repos.length > 1 && !flags.includes('cross-repo')) block('—', 'risk-flags', `the plan works in ${h.repos.length} repos but its risk flags do not include cross-repo`);

  // 3. steps: numbering, fields, commits
  // a leading "Step 0" is a prerequisite (a worktree to create, an install): outside the numbering, the counts and the field rules
  const numbered = plan.steps[0]?.n === 0 ? plan.steps.slice(1) : plan.steps;
  if (!numbered.length && plan.sections.steps) block('—', 'steps', '§ Steps has no "### Step <n> — <name>" heading');
  if (numbered.some((s, i) => s.n !== i + 1)) block('—', 'steps', `steps are numbered ${numbered.map((x) => x.n).join(', ')}; they run 1, 2, 3 …`);
  numbered.forEach((s) => {
    for (const f of ['Files', 'Change', 'Checkpoint', 'Commit']) {
      if (!s.fields[f]) block(s.n, 'step-fields', `step ${s.n} has no "${f}:" line`);
      else if (!s.fields[f].lines.join('').trim()) block(s.n, 'step-fields', `step ${s.n}'s "${f}:" is empty`);
    }
    if (s.commit && !s.commit.yes && !s.commit.no) block(s.n, 'commits', `step ${s.n}'s Commit is "${s.commit.text.slice(0, 40)}": it starts with yes or no`);
    if (s.commit?.folded !== null && s.commit?.folded !== undefined) {
      if (s.commit.folded === s.n) block(s.n, 'commits', `step ${s.n} is folded into itself`);
      else if (!numbered.some((x) => x.n === s.commit.folded)) block(s.n, 'commits', `step ${s.n} is folded into step ${s.commit.folded}, which does not exist`);
    }
  });
  // a chain of folds that comes back to where it began never reaches a commit
  const byN = new Map(numbered.map((s) => [s.n, s]));
  for (const s of numbered) {
    const seen = new Set([s.n]);
    for (let cur = s; cur?.commit?.folded != null;) {
      const next = byN.get(cur.commit.folded);
      if (!next) break; // a missing target is reported above
      if (seen.has(next.n)) { if (seen.size > 1 && Math.min(...seen) === s.n) block(s.n, 'commits', `steps ${[...seen].join(', ')} are folded into each other in a circle: none of them commits`); break; }
      seen.add(next.n);
      cur = next;
    }
  }

  // 4. counts against plan.json, status and flags against the header
  const openCount = plan.questions.length;
  if (planJson) {
    if (Number.isInteger(planJson.steps) && planJson.steps !== numbered.length) block('—', 'counts', `plan.json says ${planJson.steps} steps, plan.md has ${numbered.length}`);
    if (Number.isInteger(planJson.openQuestions) && planJson.openQuestions !== openCount) block('—', 'counts', `plan.json says ${planJson.openQuestions} open questions, plan.md lists ${openCount}`);
    if (planJson.status && h.status && planJson.status !== h.status) block('—', 'counts', `plan.json status is ${planJson.status}, plan.md says ${h.status}`);
    if (Array.isArray(planJson.flags) && h.flags) {
      const a = [...planJson.flags].sort().join(','); const b = flags.slice().sort().join(',');
      if (a !== b) block('—', 'counts', `plan.json flags are [${planJson.flags.join(', ')}], plan.md's risk flags are [${flags.join(', ')}]`);
    }
  } else skipped.push('counts');
  if (h.status === 'ready' && openCount > 0) block('—', 'questions', `status is ready but § Open questions lists ${openCount}`);
  if (h.status === 'open-questions' && openCount === 0) block('—', 'questions', 'status is open-questions but § Open questions lists none');
  for (const q of plan.questions) if (!/default/i.test(q.text)) add('advisory', '—', 'questions', `open question ${q.n} does not state the default the plan assumes if it is unanswered`);

  // 5. the acceptance criteria are the ticket's
  if (ctx.ticket && Array.isArray(ctx.ticket.acceptanceCriteria)) {
    if (plan.criteria.length !== ctx.ticket.acceptanceCriteria.length) block('—', 'criteria', `§ Goal numbers ${plan.criteria.length} acceptance criteria, ticket.json has ${ctx.ticket.acceptanceCriteria.length}`);
  } else skipped.push('criteria');

  // 6. template leftovers and "as discussed"
  const leftovers = [];
  plan.rawLines.forEach((l, i) => {
    if (plan.fenced[i]) return;
    const bare = withoutCode(l);
    if (/^#{1,3}\s.*<(ticket id|title|n|name)>/.test(bare) || /^(status|risk flags|repos)\s*:\s*<[^>]+>\s*$/.test(bare) || /^- (Files|Change|Pattern|Checkpoint|Commit)\b[^:]*:\s*<[^>]+>\s*$/.test(bare)) leftovers.push({ line: i + 1, what: `template placeholder left in: ${l.trim().slice(0, 60)}` });
    const m = /\b(as discussed|as agreed|to be decided|TBD)\b/i.exec(bare);
    if (m && !/^\s*>/.test(l)) leftovers.push({ line: i + 1, what: `"${m[1]}" — the implementer has the plan and the repo, not the conversation` });
  });
  for (const x of leftovers.slice(0, 5)) block('—', 'placeholders', `line ${x.line}: ${x.what}`);

  // 7. files and citations against the worktrees
  if (!usable) { skipped.push('files', 'citations'); } else {
    const exists = (rel) => candidates(rel, { ...ctx, repos }).some((p) => isFile(p) || isDir(p)) || bySuffix(rel, { repos }).length > 0;
    const newHere = new Set(plan.steps.flatMap((s) => (s.files || []).filter((f) => f.kind === 'new').map((f) => f.path)));
    for (const s of plan.steps) {
      for (const f of s.files || []) {
        if (/<[^>]+>/.test(f.path) || /[*{}]/.test(f.path)) continue; // a template path or a glob is not one file
        if (f.kind === 'edit' && !exists(f.path)) block(s.n, 'files', `step ${s.n} edits \`${f.path}\`, which is in no worktree — a path the repo does not have, or a file the plan should declare (new)`);
        if (f.kind === 'new' && !isAbsolute(f.path)) {
          const own = repos.length === 1 ? repos : repos.filter((r) => f.path.startsWith(`${r.name}/`));
          for (const r of own) {
            const rel = f.path.startsWith(`${r.name}/`) ? f.path.slice(r.name.length + 1) : f.path;
            if (r.worktree && isFile(join(r.worktree, rel))) block(s.n, 'files', `step ${s.n} creates \`${f.path}\`, which already exists in ${r.name}`);
          }
        }
      }
    }
    const seen = new Set();
    const outside = []; // cited, found nowhere, and not shaped like a path inside a repo: a design export, a doc beside the repos — not checkable
    const insideRepo = (path) => path.includes('/') && !isAbsolute(path) && repos.some((r) => r.worktree && isDir(join(r.worktree, path.split('/')[0])));
    for (const c of plan.citations) {
      const key = `${c.path}:${c.line}:${c.where}`;
      if (seen.has(key) || newHere.has(c.path)) continue;
      seen.add(key);
      const direct = candidates(c.path, { ...ctx, repos }).filter(isFile);
      const hits = direct.length ? direct : bySuffix(c.path, { repos });
      if (!hits.length) {
        if (insideRepo(c.path)) block(c.step, 'citations', `${c.where} cites \`${c.path}:${c.line}\`: no such file in any worktree`);
        else outside.push(`${c.path}:${c.line}`);
        continue;
      }
      const sizes = hits.map(linesIn).filter((n) => n !== null);
      const top = c.to || c.line;
      if (sizes.length && Math.max(...sizes) < top) block(c.step, 'citations', `${c.where} cites \`${c.path}:${c.line}${c.to ? `-${c.to}` : ''}\`, but the file has ${Math.max(...sizes)} lines`);
    }
    if (outside.length) add('advisory', '—', 'citations', `${outside.length} cited path(s) are in no worktree and were not checked: ${outside.slice(0, 4).join(', ')}${outside.length > 4 ? ', …' : ''}`);
  }

  const blocking = findings.filter((f) => f.severity === 'blocking');
  return {
    ok: blocking.length === 0,
    findings,
    stats: { steps: numbered.length, openQuestions: openCount, criteria: plan.criteria.length, citations: plan.citations.length, files: plan.steps.reduce((n, s) => n + (s.files || []).length, 0) },
    skipped: [...new Set(skipped)],
  };
}

/** A convenience for the command: read plan.md, plan.json and ticket.json from a work directory and lint. */
export function lintWorkdir(workdir, { fs = true } = {}) {
  const read = (f) => { try { return JSON.parse(readFileSync(join(workdir, f), 'utf8')); } catch { return null; } };
  const planFile = join(workdir, 'plan.md');
  if (!existsSync(planFile)) return null;
  const ticket = read('ticket.json');
  const claudeDir = resolve(workdir, '..', '..');
  const projectRoot = dirname(claudeDir);
  // a worktree recorded relative is read against the project folder, then <.claude>, then the work directory — the first that exists (state/util.mjs recordedPath)
  const place = (p) => (!p || isAbsolute(p) ? p || null : [projectRoot, claudeDir, workdir].map((b) => resolve(b, p)).find(isDir) || null);
  const repos = (ticket?.repos || []).map((r) => ({ name: r.name, worktree: place(r.worktree), path: r.path, discarded: r.discarded }));
  return lintPlan(parsePlan(readFileSync(planFile, 'utf8')), { ticket, planJson: read('plan.json'), repos, projectRoot, fs });
}
