#!/usr/bin/env node
// The office server: static files from this folder plus /office.json, computed live by the state script
// (skills/README.md § Observability). Node only, no dependencies.
//
//   node office/serve.mjs [--port 4820] [--host 127.0.0.1] [--work <.claude>/work] [--sim]
//
//   GET /                 the office page
//   GET /office.json      `state.mjs office <work>` — memoised for one second, never cached by the browser
//   GET /office.json?sim  a demo loop from sim/*.json (joins, a stop, a finish), also what `--sim` serves;
//                         open /?sim for the page in demo mode
//   GET /file?ticket=<id>&name=<plan.md|ticket.md|triage.md|report.md|accept.md|retro.md>
//                         one of a ticket's own markdown files, for the drawer — nothing else is readable
//   POST /answer          { id, stage, answer } → `state.mjs answer <work> <id> <stage> <answer> --by office`:
//                         queues the answer for that exact stop (README § Definitions, Asking the user); same
//                         origin only (the page, or no Origin header), ≤ 8 KB, refused in demo mode (403);
//                         409 when the ticket is not stopped at that stage, 422 for a bad body
//
// `start({ port, host, workroot, sim })` is exported for the Electron wrapper and the tests.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(HERE, '..');
const STATE = join(CLAUDE_DIR, 'skills', '_lib', 'state.mjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const FRAME_MS = 8000; // how long each sim frame is shown
const FILES = new Set(['plan.md', 'ticket.md', 'triage.md', 'report.md', 'accept.md', 'retro.md']); // what the drawer may read
// a stop's `doc` too, so a person answering on an inbox card can read what they are approving (skills/README.md
// § Definitions, Asking the user): a ticket's is in FILES already; a day's plan is _day/<date>.md
const readable = (id, name) => FILES.has(name) || (id === '_day' && /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
const MAX_BODY = 8192;

function readBody(req, limit) {
  return new Promise((res, rej) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { rej(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

// the state script's `answer` command, run as a child: exit 0 → the record; 3 → not stopped there; 2 → bad input
function queueAnswer(workroot, id, stage, answer) {
  return new Promise((res) => {
    execFile(process.execPath, [STATE, 'answer', workroot, id, stage, answer, '--by', 'office'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      let json = null; try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      res({ code, json, message: (stderr || '').trim() || (err ? err.message : '') });
    });
  });
}

function simFrame(now = Date.now()) {
  const dir = join(HERE, 'sim');
  const frames = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!frames.length) return { team: 'Demo', generatedAt: new Date(now).toISOString(), poll: 2500, linger: 120, projects: [], tickets: [], agents: [], problems: ['no sim frames'] };
  const frame = JSON.parse(readFileSync(join(dir, frames[Math.floor(now / FRAME_MS) % frames.length]), 'utf8'));
  // timestamps in the fixtures are relative ("-90s"); make them absolute against now so linger works
  const abs = (v) => (typeof v === 'string' && /^-\d+s$/.test(v) ? new Date(now - Number(v.slice(1, -1)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : v);
  for (const a of frame.agents || []) { a.started = abs(a.started); a.since = abs(a.since); a.updated = abs(a.updated); if (a.left) a.left.at = abs(a.left.at); }
  const deep = (v) => (Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : abs(v));
  for (const k of ['tickets', 'inbox', 'day', 'budget', 'doctor']) if (frame[k]) frame[k] = deep(frame[k]);
  return { ...frame, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), sim: true, frame: frames[Math.floor(now / FRAME_MS) % frames.length] };
}

function officeJson(workroot) {
  return new Promise((res, rej) => {
    execFile(process.execPath, [STATE, 'office', workroot], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return rej(new Error((stderr || err.message).trim()));
      try { res(JSON.parse(stdout)); } catch (e) { rej(new Error(`state script returned no JSON: ${e.message}`)); }
    });
  });
}

export function start({ port = 4820, host = '127.0.0.1', workroot = join(CLAUDE_DIR, 'work'), sim = false } = {}) {
  let cache = { at: 0, promise: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
    const json = (code, obj) => send(code, TYPES['.json'], JSON.stringify(obj));
    if (req.method === 'POST') {
      if (url.pathname !== '/answer') return send(405, 'text/plain', 'POST /answer only');
      if (sim) return json(403, { error: 'demo mode — answers are not queued' });
      // same origin only: the page itself (or a local tool sending no Origin at all)
      const origin = req.headers.origin;
      const ownPort = server.address()?.port;
      const sameOrigin = !origin || (() => { try { const o = new URL(origin); return ['127.0.0.1', 'localhost', '[::1]', host].includes(o.hostname) && Number(o.port || (o.protocol === 'https:' ? 443 : 80)) === ownPort; } catch { return false; } })();
      if (!sameOrigin) return json(403, { error: 'answers are accepted from the office page only' });
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(413, { error: 'body too large' });
      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { return json(e.message === 'body too large' ? 413 : 422, { error: e.message === 'body too large' ? e.message : 'the body must be JSON { id, stage, answer }' }); }
      const { id, stage, answer } = body || {};
      if (typeof id !== 'string' || !/^[\w.:-]{1,120}$/.test(id) || typeof stage !== 'string' || !/^[\w:-]{1,60}$/.test(stage) || typeof answer !== 'string' || !answer.trim() || answer.length > 4000) return json(422, { error: 'id, stage and a non-empty answer (≤ 4000 characters) are required' });
      const r = await queueAnswer(workroot, id, stage, answer.trim());
      if (r.code === 0 && r.json) { cache = { at: 0, promise: null }; return json(200, r.json); }
      return json(r.code === 3 ? 409 : r.code === 2 ? 422 : 500, { error: r.message || 'the answer was not queued' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'GET only');
    if (url.pathname === '/file') {
      const id = url.searchParams.get('ticket') || ''; const name = url.searchParams.get('name') || '';
      if (sim || !/^[\w.-]{1,120}$/.test(id) || !readable(id, name)) return send(404, 'text/plain', 'not found');
      const file = join(workroot, id, name);
      if (!existsSync(file) || !statSync(file).isFile()) return send(404, 'text/plain', 'not found');
      return send(200, 'text/markdown; charset=utf-8', readFileSync(file));
    }
    if (url.pathname === '/office.json') {
      if (sim || url.searchParams.has('sim')) return send(200, TYPES['.json'], JSON.stringify(simFrame()));
      try {
        if (Date.now() - cache.at > 1000) cache = { at: Date.now(), promise: officeJson(workroot) };
        return send(200, TYPES['.json'], JSON.stringify(await cache.promise));
      } catch (e) { cache = { at: 0, promise: null }; return send(500, TYPES['.json'], JSON.stringify({ error: e.message })); }
    }
    // static files: only inside this folder, only known types, no listings
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(HERE, normalize(rel));
    const ext = extname(file);
    if (!file.startsWith(HERE + '/') || !TYPES[ext] || rel.startsWith('electron/') || !existsSync(file) || !statSync(file).isFile()) return send(404, 'text/plain', 'not found');
    return send(200, TYPES[ext], readFileSync(file));
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => {
      const { port: p } = server.address();
      res({ server, port: p, host, url: `http://${host}:${p}/${sim ? '?sim' : ''}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  start({ port: Number(opt('--port', 4820)), host: opt('--host', '127.0.0.1'), workroot: resolve(opt('--work', join(CLAUDE_DIR, 'work'))), sim: args.includes('--sim') })
    .then(({ url }) => console.log(`office: ${url}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
