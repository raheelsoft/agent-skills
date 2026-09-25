// The office page: polls /office.json and draws Team → project rooms → ticket pods → desks, plus the inbox
// (every open stop, answerable from here), the day board (the latest plan with live statuses), a ticket
// drawer and the budget gauge. Plain DOM, keyed by (slot, agent id) and patched in place so animations
// don't restart. Every stop's kind, default and resume command come from the state script — nothing is
// re-derived here (skills/README.md § Definitions, Asking the user).
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  // any value as display text — a structured question ({ text, choices, default }) as one line, never "[object Object]"
  const txt = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(' | ');
    if (typeof v === 'object') {
      const text = txt(v.text ?? v.question ?? v.q ?? '');
      const choices = [v.choices, v.options].find(Array.isArray);
      let line = text;
      if (choices && choices.length) line += `${line ? ' — ' : ''}${choices.map((c) => (typeof c === 'string' ? c : c?.label ?? c?.text ?? JSON.stringify(c))).join(' | ')}?`;
      if (v.default != null && v.default !== '') line += ` Default: ${typeof v.default === 'string' ? v.default : JSON.stringify(v.default)}`;
      return line || JSON.stringify(v);
    }
    return String(v);
  };
  const tpl = (id) => document.getElementById(id).content.firstElementChild;
  const sim = new URLSearchParams(location.search).has('sim');
  const desks = new Map(); // key -> element
  const inboxEls = new Map(); // key -> element
  let backoff = 0;
  let last = null; // the last payload drawn
  let drawerTicket = null; // the ticket the drawer shows, or null

  const secondsBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / 1000;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtMin = (m) => (m == null ? '' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`);
  const fmtTime = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? (iso || '') : new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const fmtTokens = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const fmtCost = (c) => (c == null ? '' : `$${c.toFixed(2)}`);
  // per-viewer conveniences only (a remembered inbox state, seen stops): never state anyone else needs
  const store = {
    get(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window, blocked storage: fine */ } },
  };
  async function copy(text, note) {
    try { await navigator.clipboard.writeText(text); if (note) flash(note, 'copied'); } catch {
      const ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); if (note) flash(note, 'copied'); } catch { if (note) flash(note, text); }
      ta.remove();
    }
  }
  function flash(node, text) { node.textContent = text; node.hidden = false; setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, 2500); }

  function deskFor(key) {
    let e = desks.get(key);
    if (!e) { e = tpl('desk-tpl').cloneNode(true); e.dataset.key = key; desks.set(key, e); }
    return e;
  }

  function paintDesk(e, a, extra = {}) {
    e.dataset.level = a.level;
    e.dataset.status = a.status;
    $('.name', e).textContent = a.name;
    $('.lvl', e).textContent = a.level === 'placeholder' ? 'run' : a.level;
    $('.role', e).textContent = extra.roleText ?? (a.role === a.level ? a.stage : `${a.role} · ${a.stage}`);
    $('.rating', e).textContent = a.rating || '';
    const q = a.question ? `\nquestion: ${txt(a.question)}` : '';
    e.title = `${a.name} — ${a.level}${a.role !== a.level ? ` (${a.role})` : ''}\nstage: ${a.stage}${a.ticket ? `\nticket: ${a.ticket}` : ''}\nstatus: ${a.status} since ${a.since || a.started}${q}`;
    e.dataset.details = JSON.stringify({ id: a.id, parent: a.parent, started: a.started, since: a.since, status: a.status, question: a.question, projects: a.projects });
  }

  function place(container, e) {
    if (e.parentElement !== container) container.appendChild(e);
  }

  function visible(a, payload) {
    if (a.status !== 'done' && a.status !== 'gone') return true;
    return secondsBetween(payload.generatedAt, a.since || a.started) <= payload.linger;
  }

  // ---- the office floor -------------------------------------------------------------------------------
  function renderFloor(payload) {
    const agents = (payload.agents || []).filter((a) => visible(a, payload));
    const tickets = Object.fromEntries((payload.tickets || []).map((t) => [t.id, t]));
    const seen = new Set();

    // managers: one desk each; a ticket with a live lock but no manager gets a placeholder (an unattended run)
    const lane = $('[data-slot="managers"]');
    const managers = agents.filter((a) => a.level === 'manager');
    for (const a of managers) { const key = `managers|${a.id}`; seen.add(key); const e = deskFor(key); paintDesk(e, a, { roleText: a.ticket || a.stage }); place(lane, e); }
    for (const t of payload.tickets || []) {
      if (!t.lock || t.lock.stale || managers.some((m) => m.ticket === t.id)) continue;
      const key = `managers|lock:${t.id}`; seen.add(key);
      const e = deskFor(key);
      paintDesk(e, { id: `lock:${t.id}`, name: t.lock.owner, level: 'placeholder', role: 'placeholder', stage: t.next || 'run', ticket: t.id, status: 'working', since: t.lock.since, started: t.lock.since, rating: '', question: null, parent: null, projects: [] }, { roleText: t.id });
      place(lane, e);
    }
    $('#managers').hidden = !lane.children.length && !(payload.tickets || []).length;

    // rooms: one per project
    const roomsEl = $('#rooms');
    const wanted = new Map((payload.projects || []).map((p) => [p.name, p]));
    for (const e of [...roomsEl.children]) if (!wanted.has(e.dataset.project)) e.remove();
    for (const [name, p] of wanted) {
      let room = [...roomsEl.children].find((e) => e.dataset.project === name);
      if (!room) { room = tpl('room-tpl').cloneNode(true); room.dataset.project = name; roomsEl.appendChild(room); }
      $('.room-name', room).textContent = name;
      const pods = $('.pods', room);
      const ids = p.tickets || [];
      for (const e of [...pods.children]) if (!ids.includes(e.dataset.ticket)) e.remove();
      let people = 0;
      for (const id of ids) {
        const t = tickets[id] || { id };
        let pod = [...pods.children].find((e) => e.dataset.ticket === id);
        if (!pod) { pod = tpl('pod-tpl').cloneNode(true); pod.dataset.ticket = id; pods.appendChild(pod); }
        $('.pod-id', pod).textContent = id;
        $('.pod-title', pod).textContent = t.title || '';
        const next = $('.pod-next', pod);
        next.textContent = t.stopped ? `· ${t.stopped.kind || 'stopped'}: ${txt(t.stopped.question)}` : t.next ? `· next ${t.next}` : t.status === 'closed' ? '· closed' : '· done';
        next.classList.toggle('stopped', !!t.stopped);
        const here = agents.filter((a) => a.ticket === id && a.projects.includes(name) && a.level !== 'manager');
        const leads = $('[data-slot="leads"]', pod), crew = $('[data-slot="crew"]', pod);
        for (const a of here) {
          const key = `${name}|${id}|${a.id}`; seen.add(key); if (a.status === 'working' || a.status === 'stopped') people++;
          const e = deskFor(key); paintDesk(e, a);
          place(a.level === 'lead' || a.level === 'reviewer' ? leads : crew, e);
        }
        crew.hidden = !crew.children.length;
        if (!here.length && !$('.empty', pod)) { const e = el('div', 'empty', 'nobody at a desk'); leads.appendChild(e); }
        if (here.length) $('.empty', pod)?.remove();
      }
      if (!ids.length && !$('.empty', pods)) pods.appendChild(el('div', 'empty', 'no active ticket'));
      if (ids.length) $('.empty', pods)?.remove();
      $('.room-count', room).textContent = people ? `${people} at work` : 'quiet';
    }

    // meeting room: agents with no project (no ticket)
    const meeting = $('[data-slot="unassigned"]');
    const loose = agents.filter((a) => a.level !== 'manager' && !a.projects.length);
    for (const a of loose) { const key = `unassigned|${a.id}`; seen.add(key); const e = deskFor(key); paintDesk(e, a); place(meeting, e); }
    $('#meeting').hidden = !loose.length;

    // remove desks nobody claimed this round
    for (const [key, e] of desks) if (!seen.has(key)) { e.remove(); desks.delete(key); }

    const counts = { working: 0, stopped: 0 };
    for (const a of agents) if (a.status in counts) counts[a.status]++;
    $('#counts').textContent = `${counts.working} working · ${counts.stopped} stopped`;
    const problems = $('#problems');
    problems.hidden = !(payload.problems || []).length;
    problems.textContent = (payload.problems || []).join('\n');
  }

  // ---- the inbox: every open stop, with what continues it -----------------------------------------------
  const needsPerson = (i) => !i.answer && !i.resumable;
  const itemKey = (i) => `${i.id}|${i.stage}|${i.since || ''}`;

  function inboxItemEl(i, key) {
    let e = inboxEls.get(key);
    if (!e) {
      e = tpl('inbox-item-tpl').cloneNode(true); e.dataset.key = key; inboxEls.set(key, e);
      $('.copy', e).addEventListener('click', () => copy(i.resume || '', $('.answer-note', e)));
      $('.answer-toggle', e).addEventListener('click', () => { const f = $('.answer-form', e); f.hidden = !f.hidden; if (!f.hidden) { const t = $('.answer-text', f); if (!t.value) t.value = e.dataset.default || ''; t.focus(); } });
      $('.answer-cancel', e).addEventListener('click', () => { $('.answer-form', e).hidden = true; });
      $('.answer-form', e).addEventListener('submit', (ev) => { ev.preventDefault(); postAnswer(e.dataset.id, e.dataset.stage, $('.answer-text', e).value.trim(), $('.answer-note', e), e); });
    }
    e.dataset.id = i.id; e.dataset.stage = i.stage || ''; e.dataset.default = i.default || '';
    e.dataset.kind = i.kind || 'question';
    $('.kind', e).textContent = i.kind || 'question';
    $('.item-id', e).textContent = i.id;
    $('.item-stage', e).textContent = i.stage ? `· ${i.stage}` : '';
    $('.item-wait', e).textContent = i.waitingMin != null ? `· waiting ${fmtMin(i.waitingMin)}` : '';
    const link = $('.item-link', e); link.hidden = !i.link; if (i.link) link.href = i.link;
    $('.item-question', e).textContent = txt(i.question);
    // the document this stop is about: nobody approves a plan from a one-line question (README § Definitions, Asking the user)
    const doc = $('.item-doc', e); const parts = String(i.doc || '').split('/');
    doc.hidden = parts.length !== 2;
    if (!doc.hidden) { doc.href = `/file?ticket=${encodeURIComponent(parts[0])}&name=${encodeURIComponent(parts[1])}`; doc.textContent = `read ${parts[1]} ↗`; }
    const needs = $('.item-needs', e);
    const extra = [];
    if (i.kind === 'error' && i.needs) extra.push(`needs: ${i.needs}`);
    if (i.kind === 'blocked') {
      const b = (i.blockedBy || []).map((x) => `${x.id}${x.state ? ` (${x.state}${x.resolved ? ', resolved' : x.soft ? ', soft' : ''})` : ''}`).join(', ');
      extra.push(b ? `blocked by ${b}${i.resumable ? ' — unblocked: the next /tp-inbox or /tp-plan-day resumes it' : ''}` : 'blockers not recorded yet');
    }
    if (i.kind === 'usage') extra.push(i.resetAt ? `resets ${fmtTime(i.resetAt)}${i.resumable ? ' — resumes on the next /tp-inbox or /tp-plan-day' : ''}` : 'reset time unknown');
    if (i.kind === 'problem' && i.needs) extra.push(`fix: ${i.needs}`);
    if (i.lock && !i.lock.stale) extra.push(`run locked by ${i.lock.owner}`);
    if (i.resume) extra.push(`resume: ${i.resume}`);
    needs.textContent = extra.join('\n'); needs.hidden = !extra.length;
    const ans = $('.item-answer', e);
    if (i.answer) { ans.textContent = `answer queued: “${i.answer.text}” (${i.answer.by}, ${fmtTime(i.answer.queuedAt)}) — taken by the next run of this ticket`; ans.hidden = false; $('.answer-form', e).hidden = true; }
    else ans.hidden = true;
    const answerable = !sim && i.kind !== 'blocked' && i.kind !== 'usage';
    $('.answer-toggle', e).hidden = !answerable;
    $('.copy', e).hidden = !i.resume;
    return e;
  }

  async function postAnswer(id, stage, answer, note, item) {
    if (!answer) { flash(note, 'an answer is needed'); return; }
    if (sim) { flash(note, 'demo mode — nothing is queued'); return; }
    try {
      const r = await fetch('answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, stage, answer }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { flash(note, j.error || `HTTP ${r.status}`); return; }
      $('.answer-form', item).hidden = true;
      const ans = $('.item-answer', item); ans.textContent = `answer queued: “${answer}” — taken by the next run of this ticket`; ans.hidden = false;
      poll.soon();
    } catch (e) { flash(note, e.message); }
  }

  function renderInbox(payload) {
    const items = payload.inbox || [];
    const list = $('#inbox-list');
    const seen = new Set();
    for (const i of items) { const key = itemKey(i); seen.add(key); place(list, inboxItemEl(i, key)); }
    for (const [key, e] of inboxEls) if (!seen.has(key)) { e.remove(); inboxEls.delete(key); }
    if (!items.length && !$('.empty', list)) list.appendChild(el('div', 'empty', 'nothing is waiting on anyone'));
    if (items.length) $('.empty', list)?.remove();
    const open = items.filter(needsPerson).length;
    const badge = $('#inbox-badge'); badge.textContent = String(open); badge.hidden = !open;
    const kinds = {}; for (const i of items) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
    $('#inbox-summary').textContent = items.length ? `${items.length} open · ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ')}${items.some((i) => i.answer) ? ` · ${items.filter((i) => i.answer).length} answered` : ''}` : 'empty';
    document.title = `${open ? `(${open}) ` : ''}${payload.team} — office`;
    notifyNew(items.filter(needsPerson));
  }

  // a desktop notification per new stop — the person asked for them once (the alerts button); seen keys live in this browser only
  const seenKey = 'office.seen';
  function notifyNew(items) {
    const seen = new Set(store.get(seenKey, []));
    const fresh = items.filter((i) => !seen.has(itemKey(i)));
    if (!fresh.length) return;
    for (const i of fresh) seen.add(itemKey(i));
    store.set(seenKey, [...seen].slice(-200));
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || sim) return;
    for (const i of fresh.slice(0, 3)) {
      try { new Notification(`${i.id} · ${i.kind}`, { body: txt(i.question).slice(0, 160), tag: itemKey(i) }); } catch { /* a renderer without notifications */ }
    }
  }
  function paintAlerts() {
    const b = $('#alerts');
    const p = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    b.textContent = `alerts: ${p === 'granted' ? 'on' : p === 'denied' ? 'blocked' : p === 'unsupported' ? 'n/a' : 'off'}`;
    b.disabled = p === 'granted' || p === 'denied' || p === 'unsupported';
    b.title = p === 'granted' ? 'a desktop notification for every new stop' : p === 'denied' ? 'notifications are blocked for this page in the browser settings' : 'click to allow a desktop notification for every new stop';
  }

  // ---- the day board -----------------------------------------------------------------------------------
  function renderDay(day) {
    const sec = $('#day');
    if (!day || day.error) { sec.hidden = true; return; }
    sec.hidden = false;
    const d = day.day || {};
    $('#day-summary').textContent = `${day.from}${day.iteration ? `: ${day.iteration}` : ''} · ${day.date}${day.stale ? ' (an earlier day’s plan — /tp-plan-day plans today)' : ''} · ${d.hours}h at ${Math.round((d.focus || 0) * 100)}% = ${d.perDay}h focused · lanes ${day.lanes}${day.band ? ` (${day.band})` : ''}${day.features?.length ? ` · ${day.features.join(', ')}` : ''}`;
    const first = (day.days || [])[0];
    const bar = $('#day-bar');
    if (first) { const pct = Math.min(100, Math.round((first.load / (first.capacity || 1)) * 100)); $('.bar-fill', bar).style.width = `${pct}%`; bar.classList.toggle('over', first.load > first.capacity); $('.bar-text', bar).textContent = `day 1 · ${first.load} / ${first.capacity}h${first.carried ? ` (${first.carried})` : ''}`; bar.hidden = false; } else bar.hidden = true;
    const tb = $('#day-days'); tb.textContent = '';
    for (const x of day.days || []) {
      const tr = el('tr'); tr.append(el('td', null, String(x.day)), el('td', null, x.date), el('td', null, x.tickets.map((t) => `${t.id} ${t.hours}h`).join(', ') || '—'), el('td', null, `${x.load} / ${x.capacity}h`));
      tb.appendChild(tr);
    }
    const tk = $('#day-tickets'); tk.textContent = '';
    for (const t of day.tickets || []) {
      const chip = el('span', `tchip st-${t.status || 'queued'}`, `${t.id} ${t.hours != null ? `${t.hours}h${t.hoursSource === 'model' ? '*' : ''}` : ''}`);
      chip.title = `${t.title || ''}\n${t.status}${t.stage ? ` (${t.stage})` : ''}${t.day ? ` · day ${t.day}${t.endDay && t.endDay !== t.day ? `–${t.endDay}` : ''}` : ''}${t.after?.length ? `\nafter ${t.after.join(', ')}` : ''}${t.question ? `\n${txt(t.question)}` : ''}${t.note ? `\n${t.note}` : ''}`;
      chip.dataset.ticket = t.id;
      tk.appendChild(chip);
    }
    if (!(day.tickets || []).length) tk.appendChild(el('span', 'empty', 'no ticket planned'));
    $('#day-why').textContent = day.why || '';
    const lists = $('#day-lists'); lists.textContent = '';
    const list = (title, rows) => { if (!rows.length) return; const box = el('div', 'day-list'); box.appendChild(el('b', null, title)); const ul = el('ul'); for (const r of rows) ul.appendChild(el('li', null, r)); box.appendChild(ul); lists.appendChild(box); };
    if (day.approved === null && (day.proposed || []).length) list('proposed — awaiting your go-ahead (answer the plan-day card in the inbox)', day.proposed.map((id) => `${id} would start now`));
    list('in flight', (day.inFlight || []).map((i) => `${i.id} — ${i.status}${i.stage ? ` (${i.stage})` : ''}${i.question ? ` — ${txt(i.question)}` : ''}${i.attention ? ` — ${i.attention}h of attention today` : ''}`));
    list('waiting', (day.waiting || []).map((w) => `${w.id} on ${w.on.map((o) => `${o.id} (${o.status})`).join(', ')}`));
    list('unblocked', (day.unblocked || []).map((id) => `${id} — re-queued`));
    list('skipped', (day.skipped || []).map((s) => `${s.id} — ${s.why}`));
    if ((day.undrawn || []).length) list('not drawn today', [day.undrawn.join(', ')]);
    const foot = [];
    if (day.tickets?.some((t) => t.hoursSource === 'model')) foot.push('* hours estimated by the model');
    if (foot.length) { const f = el('div', 'day-foot', foot.join(' · ')); lists.appendChild(f); }
  }

  // ---- the header chips --------------------------------------------------------------------------------
  function renderHeader(payload) {
    $('#team').textContent = payload.team;
    $('#sim').hidden = !(sim || payload.sim);
    const b = payload.budget; const bc = $('#budget');
    bc.dataset.band = b ? b.band : '';
    bc.textContent = b ? `budget: ${b.band}${b.binding ? ` · ${b.binding.label} ${b.binding.percentUsed}%${b.binding.resetsAt ? ` · resets ${fmtTime(b.binding.resetsAt)}` : ''}` : ''} · ${b.ageMin != null ? `${fmtMin(b.ageMin)} ago` : ''}` : 'budget: no reading yet';
    bc.title = b ? b.why || '' : 'the first run records the usage reading (model.mjs pick)';
    const d = payload.doctor; const dc = $('#doctor');
    dc.hidden = !d;
    if (d) { dc.dataset.ok = d.ok && !d.counts.fail ? 'ok' : 'fail'; dc.textContent = `doctor: ${d.counts.fail ? `${d.counts.fail} fail` : d.counts.warn ? `${d.counts.warn} warn` : 'ok'} · ${fmtMin(Math.round((d.ageHours || 0) * 60))} ago`; dc.title = (d.checks || []).filter((c) => c.status !== 'ok').map((c) => `${c.status}: ${c.name} — ${c.detail || ''}${c.fix ? ` → ${c.fix}` : ''}`).join('\n') || 'every check passed'; }
    const t = payload.totals; const tc = $('#totals');
    tc.hidden = !t || !t.tokens;
    if (t && t.tokens) { const today = t.today || {}; tc.textContent = `${fmtTokens(today.tokens || 0)}${today.cost != null ? ` · ${fmtCost(today.cost)}` : ''} today · ${fmtTokens(t.tokens)}${t.cost != null ? ` · ${fmtCost(t.cost)}` : ''} all${t.partial ? ' (partial)' : ''}`; tc.title = t.unpriced ? `${fmtTokens(t.unpriced)} tokens unpriced — set prices in tiers.json` : 'tokens and cost, today / all time'; }
  }

  // ---- the ticket drawer -------------------------------------------------------------------------------
  const FILES = ['plan.md', 'ticket.md', 'triage.md', 'report.md', 'accept.md', 'retro.md'];
  function openDrawer(id) { drawerTicket = id; renderDrawer(); $('#drawer').hidden = false; }
  function closeDrawer() { drawerTicket = null; $('#drawer').hidden = true; }
  function renderDrawer() {
    if (!drawerTicket || !last) return;
    const t = (last.tickets || []).find((x) => x.id === drawerTicket);
    if (!t) { closeDrawer(); return; }
    $('#drawer-id').textContent = t.id;
    $('#drawer-title').textContent = t.title || '';
    const body = $('#drawer-body'); body.textContent = '';
    const row = (label, node) => { const r = el('div', 'drow'); r.appendChild(el('span', 'dlabel', label)); const v = typeof node === 'string' ? el('span', null, node) : node; r.appendChild(v); body.appendChild(r); return r; };
    const links = el('span');
    if (t.link) { const a = el('a', null, 'ticket ↗'); a.href = t.link; a.target = '_blank'; a.rel = 'noopener'; links.appendChild(a); }
    for (const p of t.prs || []) { if (!p.url) continue; links.appendChild(document.createTextNode(links.childNodes.length ? ' · ' : '')); const a = el('a', null, `PR ↗ ${p.verdict || 'no verdict'}${p.reviewRounds ? ` ×${p.reviewRounds}` : ''}${p.merged ? ` · merged ${String(p.merged).slice(0, 7)}` : ''}`); a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; links.appendChild(a); }
    if (links.childNodes.length) row('links', links);
    const est = t.estimate ? `${t.estimate.focusedHours}h · ${t.estimate.days}d${t.estimate.source === 'pipeline' ? '*' : ''}` : '—';
    row('rating', `${t.decision || '—'} · ${t.complexity || '—'} · estimate ${est}${t.actual ? ` · actual ${t.actual.focusedHours}h` : ''}`);
    row('status', `${t.status}${t.next ? ` · next ${t.next}` : ''}${t.closed ? ` · closed: ${txt(t.closed.why)}` : ''}`);
    if (t.stopped) {
      const item = (last.inbox || []).find((i) => i.ticket === t.id);
      if (item) { const holder = el('div', 'drawer-inbox'); holder.appendChild(inboxItemEl(item, `drawer|${itemKey(item)}`)); row(t.stopped.kind || 'stop', holder); }
      else row(t.stopped.kind || 'stop', `${txt(t.stopped.question)}${t.stopped.resume ? `\nresume: ${t.stopped.resume}` : ''}`);
    }
    if ((t.blockedBy || []).length) row('blocked by', t.blockedBy.map((b) => `${b.id}${b.state ? ` — ${b.state}` : ''}${b.resolved ? ' (resolved)' : b.soft ? ' (soft)' : ''}${b.checkedAt ? ` · checked ${fmtTime(b.checkedAt)}` : ' · not checked yet'}`).join('\n') + (t.unblocked ? '\nall resolved — unblocked' : ''));
    if ((t.stages || []).length) {
      const tbl = el('table', 'stages');
      for (const s of t.stages) { const tr = el('tr', `st-${s.status}`); tr.append(el('td', null, s.name), el('td', null, s.status), el('td', null, s.at ? fmtTime(s.at) : ''), el('td', null, s.minutes != null ? fmtMin(s.minutes) : '')); tbl.appendChild(tr); }
      row('stages', tbl);
    }
    if ((t.worktrees || []).length) row('worktrees', t.worktrees.join(', '));
    if (t.lock) row('run', `${t.lock.owner} since ${fmtTime(t.lock.since)}${t.lock.stale ? ' (stale)' : ''}`);
    row('tokens', `${fmtTokens(t.tokens || 0)}${t.cost != null ? ` · ${fmtCost(t.cost)}` : ''}${t.tokensUnpriced ? ` · ${fmtTokens(t.tokensUnpriced)} unpriced` : ''}${t.tokensPartial ? ' · partial' : ''}`);
    if (t.retro) row('retro', `${t.retro.proposals} proposal(s): ${Object.entries(t.retro.byTarget || {}).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    if (t.lastEvent) row('last event', `${t.lastEvent.stage} · ${t.lastEvent.event} · ${t.lastEvent.summary || ''} (${fmtTime(t.lastEvent.ts)})`);
    if ((t.problems || []).length) row('problems', t.problems.join('\n')).classList.add('warn');
    if (!sim) {
      const files = el('div', 'files');
      for (const name of FILES) { const b = el('button', 'linkish', name); b.type = 'button'; b.addEventListener('click', () => showFile(t.id, name, files)); files.appendChild(b); }
      row('files', files);
    }
  }
  async function showFile(id, name, holder) {
    let pre = $('pre', holder.parentElement);
    if (!pre) { pre = el('pre', 'file'); holder.parentElement.appendChild(pre); }
    pre.textContent = '…';
    try {
      const r = await fetch(`file?ticket=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
      pre.textContent = r.ok ? await r.text() : `${name}: ${r.status === 404 ? 'not there yet' : `HTTP ${r.status}`}`;
    } catch (e) { pre.textContent = e.message; }
  }

  function render(payload) {
    last = payload;
    renderHeader(payload);
    renderFloor(payload);
    renderInbox(payload);
    renderDay(payload.day);
    renderDrawer();
  }

  // ---- polling -----------------------------------------------------------------------------------------
  let timer = null;
  async function poll() {
    clearTimeout(timer);
    const dot = $('#poll');
    try {
      const r = await fetch(`office.json${sim ? '?sim' : ''}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = await r.json();
      if (payload.error) throw new Error(payload.error);
      render(payload);
      $('#offline').hidden = true;
      dot.classList.add('on');
      backoff = 0;
      timer = setTimeout(poll, payload.poll || 2500);
    } catch (e) {
      $('#offline').hidden = false;
      $('#offline').textContent = `office offline — ${e.message} — retrying…`;
      dot.classList.remove('on');
      backoff = Math.min(10000, (backoff || 1000) * 2);
      timer = setTimeout(poll, backoff);
    }
  }
  poll.soon = () => { clearTimeout(timer); timer = setTimeout(poll, 300); };

  // ---- interactions ------------------------------------------------------------------------------------
  const pop = $('#popover');
  function showPop(e) {
    const d = JSON.parse(e.dataset.details || '{}');
    pop.textContent = [
      e.title,
      `id: ${d.id}`, d.parent ? `parent: ${d.parent}` : null, `started: ${d.started}`, d.projects?.length ? `projects: ${d.projects.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    const r = e.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 380))}px`;
    pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - 160))}px`;
    pop.hidden = false;
  }
  document.addEventListener('click', (e) => {
    const desk = e.target.closest('.desk');
    if (desk) { showPop(desk); return; }
    pop.hidden = true;
    const head = e.target.closest('.pod-head');
    if (head) { openDrawer(head.parentElement.dataset.ticket); return; }
    const chip = e.target.closest('.tchip[data-ticket]');
    if (chip && (last?.tickets || []).some((t) => t.id === chip.dataset.ticket)) openDrawer(chip.dataset.ticket);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pop.hidden = true; if (!$('#drawer').hidden) closeDrawer(); }
    if (e.key === 'Enter' && e.target.classList?.contains('desk')) showPop(e.target);
    if (e.key === 'Enter' && e.target.classList?.contains('pod-head')) openDrawer(e.target.parentElement.dataset.ticket);
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  const inboxOpen = (open) => { $('#inbox').hidden = !open; store.set('office.inbox', open); };
  $('#inbox-toggle').addEventListener('click', () => inboxOpen($('#inbox').hidden));
  $('#inbox-close').addEventListener('click', () => inboxOpen(false));
  inboxOpen(store.get('office.inbox', true));
  $('#alerts').addEventListener('click', async () => { if (typeof Notification !== 'undefined') { try { await Notification.requestPermission(); } catch { /* denied */ } } paintAlerts(); });
  paintAlerts();

  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
  poll();
})();
