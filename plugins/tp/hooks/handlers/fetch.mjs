// fetch — PreToolUse on WebFetch and WebSearch, for the researcher only (the person's own session reads what it likes). The researcher reads
// documentation from the sites tiers.json `research.allow` names — https, no credentials in the address — and no more pages than
// `research.maxFetches` (8): bounded by a count a prompt cannot argue with. A fetch the policy allows is allowed outright, so research runs without
// a permission rule per site; an empty allow list means no web at all, and the researcher works from the codebase.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tpProject, workRoot, allow, deny } from '../shared.mjs';

const DEFAULT_FETCHES = 8;

/** `tiers.json`'s research block: { allow: [domains], maxFetches }. */
export function researchConfig(ctx) {
  let r = {};
  try { r = JSON.parse(readFileSync(join(ctx.claudeDir, 'tiers.json'), 'utf8')).research || {}; } catch { /* no tiers.json: nothing allowed */ }
  const list = Array.isArray(r.allow) ? r.allow.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) : [];
  return { allow: list, maxFetches: Number(r.maxFetches) > 0 ? Number(r.maxFetches) : DEFAULT_FETCHES };
}

/** Is this host one of the allowed domains, or a subdomain of one? */
export const hostAllowed = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

export default function fetch(payload, ctx) {
  if (!['WebFetch', 'WebSearch'].includes(payload.tool_name) || payload.agent_type !== 'tp:researcher' || !tpProject(ctx)) return null;
  const cfg = researchConfig(ctx);
  if (payload.tool_name === 'WebSearch') return deny('refused: the researcher reads documentation from the sites the project allows; it does not search the web. Say in `unknowns` what the codebase and those sites could not settle.');
  if (!cfg.allow.length) return deny('refused: no documentation site is allowed for research (tiers.json research.allow is empty): work from the codebase and put what remains in `unknowns`.');

  let url;
  try { url = new URL(String(payload.tool_input?.url)); } catch { return deny('refused: that is not a URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) return deny('refused: the researcher reads https pages, with no credentials in the address.');
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host, cfg.allow)) return deny(`refused: ${host} is not one of the sites research may read (${cfg.allow.join(', ')}).`);

  const dir = join(workRoot(ctx), '_gates');
  const file = join(dir, `${String(payload.agent_id || 'unknown').replace(/[^\w.-]/g, '_')}.fetches.json`);
  let used = 0;
  try { used = JSON.parse(readFileSync(file, 'utf8')).used || 0; } catch { /* the first page */ }
  if (used >= cfg.maxFetches) return deny(`refused: ${used} pages read already, the most research may read (tiers.json research.maxFetches). Record what you have; the rest goes in \`unknowns\`.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ used: used + 1 }));
  return allow(`tp: ${host} is an allowed documentation site (${used + 1} of ${cfg.maxFetches})`);
}
