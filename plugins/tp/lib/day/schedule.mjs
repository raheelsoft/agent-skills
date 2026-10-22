// schedule.mjs — a ticket's hours and the days it lands on, from the person's workday.
import { estimate } from '../model/index.mjs';

// the person's focused hours a ticket costs: given, else the model's estimate from the ticket's signals
export function hoursOf(t, cfg) {
  if (Number(t.hours) > 0) return { hours: Math.round(Number(t.hours) * 2) / 2, source: t.hoursSource || 'given', why: null };
  const e = estimate({ rating: t.rating || 'medium', repos: t.repos, flags: t.flags, unclear: t.unclear, novelty: t.novelty, tiers: cfg.tiers });
  return { hours: e.focusedHours, source: 'model', why: e.why };
}

// the next workday (Mon–Fri) `n` workdays after `date`
export function workday(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--; }
  return d.toISOString().slice(0, 10);
}

// first-fit into consecutive workdays: `tickets` in plan order (dependency order first), each with `hours` and `after`
export function schedule(tickets, cfg, date, initialLoad = 0) {
  const cap = cfg.perDay;
  const days = [{ day: 1, date, tickets: [], load: Math.round(initialLoad * 10) / 10, capacity: cap, carried: initialLoad ? 'in-flight attention' : null }];
  const endDay = {};
  const dayAt = (n) => { while (days.length < n) days.push({ day: days.length + 1, date: workday(date, days.length), tickets: [], load: 0, capacity: cap, carried: null }); return days[n - 1]; };
  for (const t of tickets) {
    let remaining = t.hours; let n = Math.max(1, ...t.after.map((a) => endDay[a] ?? 1)); t.day = null; t.slices = [];
    for (let guard = 0; remaining > 0 && guard < 120; guard++, n++) {
      const d = dayAt(n);
      const switchCost = d.load > 0 ? cfg.switch : 0;
      const room = cap + cfg.slack - d.load - switchCost;      // what the day can still take, slack included
      const real = cap - d.load - switchCost;                  // what it can take without running over
      if (remaining <= room) { d.load = Math.round((d.load + switchCost + remaining) * 10) / 10; d.tickets.push({ id: t.id, hours: remaining }); t.slices.push({ day: n, hours: remaining }); if (t.day == null) t.day = n; remaining = 0; endDay[t.id] = n; }
      else if (cfg.carry && real >= 1) { const part = Math.round(real * 10) / 10; d.load = Math.round((d.load + switchCost + part) * 10) / 10; d.tickets.push({ id: t.id, hours: part }); t.slices.push({ day: n, hours: part }); if (t.day == null) t.day = n; remaining = Math.round((remaining - part) * 10) / 10; }
    }
    if (remaining > 0) { const d = dayAt(n); d.tickets.push({ id: t.id, hours: remaining }); t.slices.push({ day: n, hours: remaining }); if (t.day == null) t.day = n; endDay[t.id] = n; } // never happens within the guard
    t.endDay = endDay[t.id];
  }
  return days;
}
