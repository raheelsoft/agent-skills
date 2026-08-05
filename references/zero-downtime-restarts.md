# Zero-downtime restarts — cluster mode vs fork mode

`application_start.sh.tmpl` always runs `pm2 startOrReload
ecosystem.config.js`. What that actually does on every deploy after the
first depends entirely on `instances`/`exec_mode` in the rendered
`ecosystem.config.js`:

- **`instances: 1, exec_mode: 'fork'`**: `pm2 reload` on a single instance
  is a fast restart, not a true swap — PM2 kills the one process and starts
  a new one. Any request in flight at that instant drops. Fine for an app
  where a sub-second blip on deploy is acceptable, not fine for one that
  isn't.
- **`instances: >=2, exec_mode: 'cluster'`**: PM2 brings a new worker up,
  waits until it's actually accepting connections, then kills one old
  worker — one at a time, across all workers — so at every point during
  the rollout at least one worker is serving traffic. This is the real
  zero-downtime mechanism, and it requires cluster mode with 2+ instances
  to exist at all; there's no zero-downtime fork-mode equivalent.

## Default: cluster mode for both frontend and backend

Both `templates/app/ecosystem.frontend.config.js.tmpl` and
`templates/app/ecosystem.backend.config.js.tmpl` default their
`___*_INSTANCES___`/`___*_EXEC_MODE___` placeholders to `2`/`'cluster'`.
Ask the question in Step 2b anyway, explicitly, rather than silently
assuming every backend is safe for it — Node's cluster mode runs multiple
independent OS processes of the same app, which breaks a specific, narrow
set of patterns:

- **In-memory rate limiting or caching** — each worker has its own memory,
  so a limit "shared" only within one worker isn't actually shared across
  the app. (This skill's own nginx-level `limit_req_zone` is unaffected
  either way — it rate-limits before requests ever reach the app.)
- **In-process cron/scheduled jobs** (e.g. `node-cron`, a `@Cron()`
  decorator with no distributed lock) — with 2+ workers, the job fires
  twice, at the same time, from two different processes.
- **WebSocket connections needing session affinity** without a shared
  adapter (e.g. Socket.IO without its Redis adapter) — a client's
  reconnect can land on a different worker than the one holding its state.
- **Any other server-local mutable state** the app assumes is a singleton.

None of these make an app *impossible* to run on this skill's pipeline —
they make it unsafe to run as more than one process without further
changes (a distributed lock for the cron job, a shared adapter for
WebSockets, moving the rate limiter to nginx/Redis). If the user isn't
sure, ask them to check for these patterns specifically, or default to
`instances: 1, exec_mode: 'fork'` for that one app and say plainly that
its deploys will have a brief connection drop until it's made
cluster-safe — don't let an unconfirmed cluster-mode guess silently ship a
duplicate-cron-job bug into production.

## Why this wasn't always the default

An earlier iteration of this skill defaulted the backend template
specifically to `fork`/`1`, on the theory that not every backend is
cluster-safe and fork mode was the conservative choice. In practice that
just made connection-dropping restarts the invisible default for the
*common* case (a typical stateless REST API, which is cluster-safe) to
avoid a rarer one (the patterns above) — inverted from what most apps
actually need. Asking the question explicitly, rather than picking either
default silently, is the fix; cluster mode is the better default *once
confirmed*, not a default to avoid entirely.
