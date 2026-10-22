// select.mjs — the pool draw: a seeded shuffle, and the dependency levels the chosen tickets run in.
import { createHash } from 'node:crypto';
import { byId } from './util.mjs';

// mulberry32 seeded from the seed's sha1 — the same seed draws the same tickets
export function seeded(seed) {
  let a = parseInt(createHash('sha1').update(String(seed)).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Kahn's algorithm over the `after` edges restricted to `ids`: levels (what can run together) or the cycle
export function levels(cands, ids) {
  const set = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, cands.get(id).after.filter((a) => set.has(a)).length]));
  const out = []; let layer = ids.filter((id) => indeg.get(id) === 0).sort(byId);
  const seen = new Set();
  while (layer.length) {
    out.push(layer); layer.forEach((id) => seen.add(id));
    const next = [];
    for (const id of ids) {
      if (seen.has(id) || next.includes(id)) continue;
      if (cands.get(id).after.filter((a) => set.has(a)).every((a) => seen.has(a))) next.push(id);
    }
    layer = next.sort(byId);
  }
  const cycle = ids.filter((id) => !seen.has(id)).sort(byId);
  return { levels: out, cycle };
}
