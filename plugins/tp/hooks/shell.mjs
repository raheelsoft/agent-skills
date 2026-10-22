// shell.mjs — enough of a shell parser for a hook to answer two questions about a Bash command: which programs does it run with which
// words, and where does it write. It understands quotes, escapes, the separators ; & | and newline, redirections, heredocs (the body is
// skipped, never parsed), `bash -c '…'` (parsed again) and notes what it cannot see (`$(…)`, backticks) as `opaque`. It is not a shell:
// anything cleverer than that is left to the permission system. A rule built on it is a guard rail, never a security boundary.
//
//   parseShell("git commit -m 'x' && cat > a.json <<'E'\n…\nE")
//   -> [ { words: ['git','commit','-m','x'], redirects: [], opaque: false },
//        { words: ['cat'], redirects: [{ op: '>', target: 'a.json' }, { op: '<<', target: 'E' }], opaque: false } ]

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const WRAPPERS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '(', '!', 'time', 'command', 'exec', 'nohup', 'sudo', 'env', 'xargs', 'nice']);
const MAX_DEPTH = 3;

const base = (p) => String(p).split('/').pop();

/** The commands of a command line, in order. Never throws. */
export function parseShell(src, depth = 0) {
  const text = String(src ?? '');
  const out = [];
  let cur = { words: [], redirects: [], opaque: false };
  let word = null;
  let pending = null; // a redirection operator waiting for its target
  let heredocs = []; // tags whose bodies follow the current line
  let i = 0;

  const flushWord = () => {
    if (word === null) return;
    if (pending) {
      cur.redirects.push({ op: pending, target: word });
      if (pending === '<<' || pending === '<<-') heredocs.push({ tag: word, strip: pending === '<<-' });
      pending = null;
    } else cur.words.push(word);
    word = null;
  };
  const endCommand = () => {
    flushWord();
    if (cur.words.length || cur.redirects.length) out.push(cur);
    cur = { words: [], redirects: [], opaque: false };
    pending = null;
  };
  const append = (s) => { word = (word ?? '') + s; };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; } // a line continuation
      append(text[i + 1] ?? ''); i += 2; continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      append(text.slice(i + 1, stop)); if (word === null) word = '';
      i = stop + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1; let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1]; j += 2; continue; }
        if (text[j] === '`' || (text[j] === '$' && text[j + 1] === '(')) cur.opaque = true;
        s += text[j]; j++;
      }
      append(s); if (word === null) word = '';
      i = j + 1; continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end < 0 ? text.length : end;
      cur.opaque = true; append(text.slice(i, stop + 1)); i = stop + 1; continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      let depthParen = 0; let j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') depthParen++; else if (text[j] === ')' && --depthParen === 0) break; }
      cur.opaque = true; append(text.slice(i, j + 1)); i = j + 1; continue;
    }
    if (ch === '#' && word === null) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === ' ' || ch === '\t') { flushWord(); i++; continue; }
    if (ch === '\n') {
      endCommand(); i++;
      for (const tag of heredocs) { // the bodies of the heredocs opened on the line that just ended: skipped
        while (i < text.length) {
          const nl = text.indexOf('\n', i);
          const line = text.slice(i, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl + 1;
          if ((tag.strip ? line.trim() : line) === tag.tag) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (ch === ';') { endCommand(); i++; continue; }
    if (ch === '|') { endCommand(); i += text[i + 1] === '|' ? 2 : 1; continue; }
    if (ch === '&') {
      if (text[i + 1] === '&') { endCommand(); i += 2; continue; }
      if (text[i + 1] === '>') { flushWord(); pending = text[i + 2] === '>' ? '&>>' : '&>'; i += pending.length; continue; }
      endCommand(); i++; continue; // a backgrounded command
    }
    if (ch === '>' || ch === '<') {
      // a bare file-descriptor number in front of the operator (2>&1) belongs to it
      if (word !== null && /^\d+$/.test(word)) word = null; else flushWord();
      let op = ch;
      if (ch === '>' && text[i + 1] === '>') { op = '>>'; i++; }
      else if (ch === '>' && text[i + 1] === '|') { op = '>|'; i++; }
      else if (ch === '>' && text[i + 1] === '&') { // 2>&1, >&2: a descriptor copy, no file
        i += 2; while (/[\d-]/.test(text[i] ?? '')) i++;
        continue;
      } else if (ch === '<' && text[i + 1] === '<' && text[i + 2] === '<') { op = '<<<'; i += 2; }
      else if (ch === '<' && text[i + 1] === '<') { op = text[i + 2] === '-' ? '<<-' : '<<'; i += op.length - 1; }
      pending = op;
      i++;
      // skip spaces so the target is the next word; a heredoc's target is its tag
      continue;
    }
    append(ch); i++;
  }
  endCommand();

  // a heredoc's "target" is its tag, not a file: record it as a marker only
  const result = out.map((c) => ({ ...c, redirects: c.redirects.map((r) => (r.op === '<<' || r.op === '<<-' ? { op: r.op, target: r.target, heredoc: true } : r)) }));

  // a shell run on a script string: its commands count too (`bash -c 'git push --force'`)
  if (depth < MAX_DEPTH) {
    for (const c of [...result]) {
      const k = programIndex(c.words);
      if (k >= 0 && SHELLS.has(base(c.words[k]))) {
        const flag = c.words.findIndex((w, j) => j > k && /^-[a-z]*c[a-z]*$/.test(w));
        if (flag >= 0 && c.words[flag + 1] !== undefined) result.push(...parseShell(c.words[flag + 1], depth + 1).map((n) => ({ ...n, nested: true })));
      }
    }
  }
  return result;
}

/** Where the program is among a command's words: past `VAR=value` assignments and wrapper words (sudo, time, then, xargs …). -1 when there is none. */
export function programIndex(words) {
  let k = 0;
  while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || WRAPPERS.has(words[k]))) {
    const wrapper = WRAPPERS.has(words[k]);
    k++;
    while (wrapper && k < words.length && /^-/.test(words[k])) k++; // a wrapper's own options: sudo -n, xargs -n1, nice -n
  }
  return k < words.length ? k : -1;
}

/** `{ name, args }` of a command's program ("git", ["push", "--force"]), or null. */
export function programOf(command) {
  const k = programIndex(command.words);
  return k < 0 ? null : { name: base(command.words[k]), args: command.words.slice(k + 1) };
}

/** For `git`, the subcommand and what follows it, past `-C <path>`, `-c k=v` and the other options that come first. */
export function gitOf(command) {
  const p = programOf(command);
  if (!p || p.name !== 'git') return null;
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
  let k = 0;
  while (k < p.args.length && p.args[k].startsWith('-')) k += takesValue.has(p.args[k]) ? 2 : 1;
  return k < p.args.length ? { sub: p.args[k], args: p.args.slice(k + 1), all: p.args } : null;
}

/**
 * The files a command writes: redirections, tee, cp/mv/install's destination, sed -i and perl -i's files, dd of=, truncate — and, with
 * `removals`, what rm, rmdir and unlink delete.
 */
export function writeTargets(command, { removals = false } = {}) {
  const out = command.redirects.filter((r) => ['>', '>>', '>|', '&>', '&>>'].includes(r.op)).map((r) => r.target);
  const p = programOf(command);
  if (!p) return out;
  const files = p.args.filter((a) => !a.startsWith('-'));
  if (p.name === 'tee' || p.name === 'truncate') out.push(...files);
  else if ((p.name === 'cp' || p.name === 'mv' || p.name === 'install') && files.length >= 2) out.push(files[files.length - 1]);
  else if ((p.name === 'sed' || p.name === 'perl') && p.args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place')) out.push(...files);
  else if (p.name === 'dd') out.push(...p.args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  else if (removals && (p.name === 'rm' || p.name === 'rmdir' || p.name === 'unlink')) out.push(...files);
  if (removals && p.name === 'mv') out.push(...files.slice(0, -1)); // the source of a move is gone afterwards
  return out;
}
