# Static-site (S3+CloudFront) analysis and conversion

Only relevant for the **frontend** app type, and only actually offered as a
choice — never assumed. This doc is the analysis playbook: what to check in
the repo, how to classify the result, and what "minimal changes" actually
means before you tell a user their app qualifies.

## Step 1: check for static-export blockers

Search the repo (`app/`/`pages/` directories) for each of these. Any one of
them means the app needs a real Node server — do not offer conversion, tell
the user why and proceed straight to the EC2 path:

- **API routes**: `app/api/**/route.ts` (App Router) or `pages/api/**` (Pages
  Router). These need a server to execute — a static export can't run them.
- **Middleware**: `middleware.ts`/`middleware.js` at the repo root. Runs
  per-request on a server; has no equivalent in a static export.
- **`getServerSideProps`**: grep for it across `pages/`. Forces per-request
  server rendering by definition — incompatible with `output: 'export'`.
- **Route Handlers with dynamic behavior**: any `route.ts` reading
  `request.headers`/`request.cookies`/search params to vary its response
  per-request (as opposed to a route that could just be static JSON).
- **ISR (`revalidate` on a page/fetch outside build time)**: incremental
  regeneration needs a server to actually revalidate. A `revalidate` used
  purely as a build-time `fetch` cache hint (no runtime revalidation
  expected) isn't necessarily a blocker — read the actual usage, don't just
  grep-and-flag the keyword.
- **`next/image` without `images.unoptimized: true`**: the Image
  Optimization API needs a server. Not an automatic blocker — see Step 2,
  this one's usually fixable.
- **Server Actions** (`'use server'` functions called from the client):
  need a server to execute.

If none of these are present, the app is **already static-exportable**.

## Step 2: if blockers exist, judge whether they're "minimal" to remove

Only offer conversion if the fix is genuinely small and mechanical. Minimal,
generally safe to describe as an option:
- `next/image` used without `unoptimized: true` → setting
  `images: { unoptimized: true }` in `next.config` fixes it (images are
  simply served unoptimized instead of resized/converted on the fly — a
  real tradeoff to mention, not a free lunch).
- A dynamic route (`app/blog/[slug]/page.tsx`) missing
  `generateStaticParams` → adding it (enumerating the known slugs at build
  time) fixes it, **if** the data source for enumerating them is available
  at build time (e.g. a CMS API, a local content directory). If the slugs
  are only knowable per-request, this is NOT minimal — it's a real
  architecture constraint, not a quick fix.

Not minimal — don't offer conversion, explain why instead:
- Real API routes doing real work (auth, form submission, webhooks,
  database access). These need to go *somewhere* that can run
  server-side — if a backend API already exists in this project (the
  `discovery-town-be`-shaped app), point out that the logic likely belongs
  there instead, but don't move it yourself as a side effect of infra
  setup — that's an application-code decision for the user/dev team.
- `getServerSideProps` used for anything beyond what `generateStaticParams`
  + build-time fetching could replace (e.g. genuinely per-user/per-request
  content, A/B testing, auth-gated pages).
- Middleware doing real request-time logic (auth checks, redirects based on
  cookies, geo-based routing).

## Step 3: ask, don't decide

If Step 1 found nothing, or Step 2 concluded the fix is genuinely minimal,
use `AskUserQuestion`:

> This frontend looks static-exportable [with N small changes: list them
> plainly]. Deploying it as a static site on S3+CloudFront is simpler and
> cheaper than running it on EC2 — no server to patch, no pm2, no nginx.
> Do you want to convert and deploy on S3+CloudFront, or deploy on EC2
> intentionally (e.g. you're planning to add server-side features soon, or
> want consistency with the rest of your infra)?

Never convert without an explicit yes — "intentionally EC2" is a completely
valid answer even for a fully static app (simplicity of having one deploy
model across services, room to grow into SSR later, etc.), and the question
exists precisely so that reasoning gets a chance to surface rather than the
skill silently picking the "better" option.

If the user says no blockers exist but chooses EC2 anyway, that's the end
of it — proceed with the normal EC2 path (Steps 4/7/8/10 in SKILL.md),
nothing about the app changes.

## Step 4: making the changes (only after explicit yes)

- Show the exact diff before writing it — `next.config` gaining
  `output: 'export'` (and `images: { unoptimized: true }` if needed), any
  `generateStaticParams` addition, at minimum.
- Don't touch anything not required for the export to build — no
  unrelated refactoring, no dependency upgrades, no "while I'm in here"
  cleanup.
- After the change, actually run the build (`npm run build`) locally
  against the repo to confirm `out/` gets produced and nothing broke,
  before wiring up the pipeline around it. A change that "should" work but
  was never actually built is not verified.

## What this replaces in the rest of the skill

Once the static path is chosen, `templates/cfn/ec2-instance.yaml` and
`templates/cfn/pipeline.yaml`/`github-oidc-role.yaml` are **not** used for
this app at all — see SKILL.md's branching in Steps 4/7/8/10 for exactly
which templates substitute in (`static-site-s3.yaml`,
`static-site-pipeline.yaml` or `github-oidc-role-static.yaml`,
`buildspec.static.yml.tmpl`, `deploy-static.yml.tmpl`). If this app also
has a companion backend, the backend still goes through the normal EC2
path unaffected — this only changes how the frontend itself is hosted.
