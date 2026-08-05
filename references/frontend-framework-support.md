# Frontend start command — framework-agnostic by design

`templates/app/ecosystem.frontend.config.js.tmpl` does not hardcode a
framework. `___FRONTEND_START_SCRIPT___`/`___FRONTEND_START_ARGS___` are
filled in during Step 2b from the app's actual production start command,
not assumed — this skill only ever special-cases Next.js as a *default
suggestion*, never as the only supported option.

## What to ask

"What's the production start command for this frontend, after `npm run
build`?" — check `package.json`'s `scripts.start` first (most frameworks
put the right command there already), and suggest it as the default rather
than asking blind. Common shapes:

| Framework | Typical `script`/`args` |
|---|---|
| Next.js | `node_modules/.bin/next` / `start` |
| Nuxt 3 | `node` / `.output/server/index.mjs` |
| SvelteKit (node adapter) | `node` / `build/index.js` |
| Remix (express server) | `node` / `server.js` (project-specific) |
| Custom Express/Fastify server | `node` / `dist/server.js` (or wherever it builds to) |

Don't guess from the framework alone — always confirm against what
`npm start` (or the repo's own docs) actually runs, since e.g. a Remix or
custom-server setup varies project to project even within one framework.

## What's still Next.js-specific

Only `references/static-site-conversion.md`'s analysis (whether to convert
to a static export on S3+CloudFront instead of running a server at all) is
Next.js-specific — it looks for Next.js-specific static-export blockers
(`getServerSideProps`, middleware, etc.). A non-Next.js frontend that
chooses the EC2 path skips that analysis entirely and goes straight to the
EC2-path questions in Step 2b; nothing about the EC2 deploy mechanism
itself (buildspec, `after_install.frontend.sh.tmpl`, the ecosystem
template, nginx) assumes Next.js.

## Build-time env vars still apply framework-agnostically

`references/gotchas.md`'s "Frontend build-time env vars" note (Next.js's
`NEXT_PUBLIC_*` baked in at build time, not read at runtime) has an
equivalent in every framework that ships a client bundle — Vite's
`VITE_*`, generally anything the framework itself documents as
build-time-inlined. The mechanism (a full rebuild via
`after_install.frontend.sh.tmpl` is required, editing `.env` and reloading
pm2 alone does nothing) is identical regardless of which prefix convention
the framework uses — check the framework's own docs for which vars are
build-time vs runtime before assuming either way.
