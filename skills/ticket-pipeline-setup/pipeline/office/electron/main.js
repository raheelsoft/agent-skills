// Electron shell for the office: starts the same local server the web version uses (on a free port,
// bound to localhost) and opens it in a window. `npm start`; `npm run sim` for the demo loop.
// The shell adds what a page cannot: the dock badge with the number of stops waiting on a person
// (polled from /office.json at the office's own interval) and ticket/PR links opened in the default browser.
import { app, BrowserWindow, shell } from 'electron';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(HERE, '..', '..');
const sim = process.argv.includes('--sim');
const workArg = process.argv.find((a) => a.startsWith('--work='));

let server = null;
let badgeTimer = null;

// a stop needs a person unless an answer is already queued for it or it resumes by itself
const needsPerson = (i) => !i.answer && !i.resumable;

async function refreshBadge() {
  try {
    const r = await fetch(`${server.url.replace(/\?sim$/, '')}office.json${sim ? '?sim' : ''}`);
    const j = await r.json();
    const n = (j.inbox || []).filter(needsPerson).length;
    if (app.dock) app.dock.setBadge(n ? String(n) : '');
    badgeTimer = setTimeout(refreshBadge, j.poll || 2500);
  } catch { badgeTimer = setTimeout(refreshBadge, 5000); }
}

app.whenReady().then(async () => {
  server = await start({ port: 0, host: '127.0.0.1', workroot: workArg ? resolve(workArg.slice(7)) : join(CLAUDE_DIR, 'work'), sim });
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 480,
    title: 'Office', backgroundColor: '#1b1f2a', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // a ticket or PR link opens in the person's browser, never in a second office window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL(server.url);
  refreshBadge();
});

app.on('window-all-closed', async () => {
  clearTimeout(badgeTimer);
  if (app.dock) app.dock.setBadge('');
  if (server) await server.close();
  app.quit();
});
