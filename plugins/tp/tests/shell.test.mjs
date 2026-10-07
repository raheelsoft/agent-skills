// shell.mjs — the small shell parser the Bash guard reads a command with: which programs run, with which words, and where they write.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, programOf, gitOf, programIndex } from '../hooks/shell.mjs';

const words = (src) => parseShell(src).map((c) => c.words);

describe('parseShell — commands and separators', () => {
  it('splits on ; && || | & and newlines, outside quotes only', () => {
    assert.deepEqual(words('a 1; b 2 && c 3 || d 4 | e 5 & f 6\ng 7'), [['a', '1'], ['b', '2'], ['c', '3'], ['d', '4'], ['e', '5'], ['f', '6'], ['g', '7']]);
    assert.deepEqual(words('git commit -m "a; b && c" && x'), [['git', 'commit', '-m', 'a; b && c'], ['x']]);
    assert.deepEqual(words("echo 'a | b'"), [['echo', 'a | b']]);
  });

  it('quotes join a word, escapes protect a character, a line continuation joins lines', () => {
    assert.deepEqual(words('echo "a b"c\'d e\''), [['echo', 'a bcd e']]);
    assert.deepEqual(words('echo a\\ b'), [['echo', 'a b']]);
    assert.deepEqual(words('echo a \\\n b'), [['echo', 'a', 'b']]);
    assert.deepEqual(words('echo ""'), [['echo', '']]);
  });

  it('a comment runs to the end of the line', () => {
    assert.deepEqual(words('echo a # not b; c\necho d'), [['echo', 'a'], ['echo', 'd']]);
    assert.deepEqual(words('echo a#b'), [['echo', 'a#b']]);
  });

  it('never throws, on anything', () => {
    for (const src of ['', '   ', '"unterminated', "'unterminated", '$(unterminated', '`unterminated', '<<', '>', '>>>', '&&&', ';;', '\\', 'a <<E', undefined, null]) assert.doesNotThrow(() => parseShell(src), String(src));
  });
});

describe('parseShell — redirections and heredocs', () => {
  it('records where a command writes', () => {
    const [c] = parseShell('cat a > out.json 2> err.log');
    assert.deepEqual(c.redirects, [{ op: '>', target: 'out.json' }, { op: '>', target: 'err.log' }]);
    assert.deepEqual(c.words, ['cat', 'a']);
    assert.deepEqual(parseShell('echo x >> log')[0].redirects, [{ op: '>>', target: 'log' }]);
    assert.deepEqual(parseShell('echo x>f')[0].redirects, [{ op: '>', target: 'f' }]);
    assert.deepEqual(parseShell('echo x &> both')[0].redirects, [{ op: '&>', target: 'both' }]);
    assert.deepEqual(parseShell('echo x >| forced')[0].redirects, [{ op: '>|', target: 'forced' }]);
  });

  it('a descriptor copy is no file: 2>&1, >&2', () => {
    const [c] = parseShell('make 2>&1 | tail');
    assert.deepEqual(c.redirects, []);
    assert.deepEqual(c.words, ['make']);
    assert.deepEqual(parseShell('echo x >&2')[0].redirects, []);
  });

  it('input redirection is recorded as input', () => {
    assert.deepEqual(parseShell('sort < in.txt')[0].redirects, [{ op: '<', target: 'in.txt' }]);
  });

  it('a heredoc\'s body is skipped, never parsed as commands, whatever it holds', () => {
    const out = parseShell("cat > plan.json <<'EOF'\n{ \"a\": \"x; rm -rf /\" }\nEOF\necho after");
    assert.deepEqual(out.map((c) => c.words), [['cat'], ['echo', 'after']]);
    assert.deepEqual(out[0].redirects, [{ op: '>', target: 'plan.json' }, { op: '<<', target: 'EOF', heredoc: true }]);
  });

  it('<<- ends at an indented terminator, and two heredocs on a line each take a body', () => {
    assert.deepEqual(parseShell('cat <<-X\n\tbody\n\tX\necho after').map((c) => c.words), [['cat'], ['echo', 'after']]);
    assert.deepEqual(parseShell('cat <<A <<B\none\nA\ntwo\nB\necho after').map((c) => c.words), [['cat'], ['echo', 'after']]);
  });
});

describe('parseShell — what it cannot see', () => {
  it('flags $( ) and backticks as opaque, inside double quotes too, and keeps ; inside them from splitting', () => {
    assert.equal(parseShell('echo $(date; ls)')[0].opaque, true);
    assert.equal(parseShell('echo `date`')[0].opaque, true);
    assert.equal(parseShell('echo "x $(date)"')[0].opaque, true);
    assert.equal(parseShell("echo '$(date)'")[0].opaque, false, 'in single quotes it is text');
    assert.equal(parseShell('echo $(date; ls)').length, 1);
    assert.equal(parseShell('echo plain')[0].opaque, false);
  });

  it('reads the script of bash -c as commands too', () => {
    const out = parseShell('bash -c "git push -f && echo done"');
    assert.ok(out.some((c) => c.words.join(' ') === 'git push -f'));
    assert.ok(parseShell("sh -c 'git commit --no-verify'").some((c) => c.words.includes('--no-verify')));
    assert.ok(parseShell("sudo bash -lc 'git push --force'").some((c) => c.words.join(' ') === 'git push --force'));
  });
});

describe('programOf and gitOf', () => {
  it('finds the program past assignments and wrappers', () => {
    assert.equal(programOf(parseShell('FOO=1 BAR=2 node x.mjs a')[0]).name, 'node');
    assert.equal(programOf(parseShell('sudo -n git status')[0]).name, 'git', 'a wrapper\'s own options are not the program');
    assert.deepEqual(programOf(parseShell('xargs -n1 git push -f')[0]).args, ['push', '-f']);
    assert.equal(programIndex(['then', 'git', 'push']), 1);
    assert.equal(programIndex(['FOO=1']), -1);
    assert.equal(programOf(parseShell('/usr/bin/git log')[0]).name, 'git');
  });

  it('gitOf gives the subcommand past -C and -c, and what follows it', () => {
    assert.deepEqual(gitOf(parseShell('git -C /r -c core.x=1 push -f origin b')[0]), { sub: 'push', args: ['-f', 'origin', 'b'], all: ['-C', '/r', '-c', 'core.x=1', 'push', '-f', 'origin', 'b'] });
    assert.deepEqual(gitOf(parseShell('git --no-pager log -1')[0]).sub, 'log');
    assert.equal(gitOf(parseShell('echo git push')[0]), null);
    assert.equal(gitOf(parseShell('git')[0]), null);
    assert.equal(gitOf(parseShell('if git push -f; then echo; fi')[0]).sub, 'push');
  });
});
