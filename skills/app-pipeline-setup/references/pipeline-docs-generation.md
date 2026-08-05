# Generating the architecture/operations docs

Render `templates/app/pipeline-architecture-report.md.tmpl` and
`templates/app/pipeline-operations-report.md.tmpl` as part of Step 14, into
the target repo (e.g. `docs/PIPELINE-ARCHITECTURE.md` and
`docs/PIPELINE-OPERATIONS.md`) — these have no secrets in them, unlike the
local-dev-env report, so they belong in the repo where the dev team will
actually find them, not off to the side. Don't `git add`/commit them
yourself (Step 14's standing rule) — leave them for the user to review.

This is the generalized version of what got hand-written once for the
project that led to this skill existing — a real dev team needed exactly
this pair of docs, and writing them by hand after the fact is the thing
this step exists to stop being necessary. **Skip this only if the user
explicitly says they don't want it** — it's cheap (no AWS resources, no
cost) and default-valuable, closer to "always do this" than the optional
reports elsewhere in this skill.

## Building each block — tailor to what was *actually* chosen this run

Don't describe paths that don't apply. A backend-only EC2 deploy with no
RDS shouldn't have a "database" section implying one exists.

### `___BIG_PICTURE___`

An ASCII flow diagram, EC2 path or static-site path as appropriate:

- **EC2 path**: `GitHub -> CodeStar Connection -> CodePipeline -> CodeBuild
  (quality gate) -> CodeBuild (SSM trigger) -> app-pipeline-deploy.sh on
  the instance -> release directory -> validate -> live` (or the GitHub
  Actions equivalent, OIDC instead of CodeStar Connection, one workflow
  instead of two CodeBuild projects).
- **Static-site path**: `GitHub -> CodePipeline/Actions -> next build
  (static export) -> S3 sync -> CloudFront invalidation -> live`.

### `___INFRA_LIST___`

One bullet per resource actually created, each with its stack name (so
it's findable later) — EC2 instance type/region, RDS class if any, S3
bucket(s) and visibility, CloudFront if any, notifications topic, uptime
check, DNS setup. Pull this straight from what Step 14's own summary
already assembled — don't re-derive it.

### `___DEPLOY_MECHANICS___`

- **EC2 path**: summarize `references/release-rollback.md` — release
  directories, the `current` symlink, automatic rollback-on-failed-
  validation, the concurrency lock. Mention the seeding behavior if backend
  + RDS/Postgres (what runs, what deliberately doesn't and why — same
  idempotency caution as the original discoverytown seeder decision).
- **Static-site path**: `next build` producing `out/`, synced directly to
  S3, CloudFront cache invalidated — no server, no release directories, no
  rollback mechanism (see the Rollback section below for what "rollback"
  means here instead).

### `___ENV_HANDLING___`

- **EC2 path**: env vars live in SSM Parameter Store as individually
  named parameters (`/{app-name}/prod/{VAR_NAME}` — see
  `references/env-parameter-store.md`), not a file someone edits directly.
  `.env` on the box is regenerated from Parameter Store on every deploy —
  changing a var means updating its parameter and redeploying, not
  SSH/SSM-editing a file. Mention the `NEXT_PUBLIC_*`-is-build-time-not-
  runtime caveat if this is a frontend (still true regardless of where the
  value comes from).
- **Static-site path**: build-time env vars live in CodeBuild
  `EnvironmentVariables` or GitHub Actions secrets — no `.env` file exists
  anywhere in this path (see SS4 in SKILL.md).

### `___KNOWN_GAPS___`

Anything flagged but not fixed during this run — the exact category of
thing the original discoverytown build had (the `ACL: 'public-read'`
S3 code incompatibility, the decision to seed auth/RBAC only and not full
mock data). If nothing was flagged, say so plainly rather than omitting
the section.

### `___BRANCH_FLOW___`

Which branch triggers a deploy (Step 2's answer), and that only that
branch does — mention the staging branch too if a staging environment
exists (`references/staging-environment.md`).

### `___WATCHING_DEPLOY___`

CLI commands for whichever CI mechanism was actually chosen — don't
include both CodePipeline and GitHub Actions commands if only one is in
use. Base this on the exact commands already used in Step 12's
verification, not invented from scratch.

### `___LOGS___`

- **EC2 + CodePipeline**: CodeBuild logs for the Build stage, SSM
  `get-command-invocation` for the actual on-box deploy output (the
  Deploy-stage CodeBuild log only shows the SSM trigger/poll, not the real
  output).
- **EC2 + GitHub Actions**: the Actions run log covers build; SSM
  `get-command-invocation` still needed for the real on-box output, same
  as above.
- **Static-site path**: CodeBuild/Actions logs cover the entire deploy —
  no SSM involved, everything's in one place.

### `___ROLLBACK___`

- **EC2 path**: automatic on a failed deploy (`references/release-rollback.md`);
  for something that passed validation but has a bug found later, revert
  the commit and redeploy, or manually re-point `current` via
  `/usr/local/bin/app-pipeline-rollback.sh`.
- **Static-site path**: no automatic mechanism — revert the commit and
  push, which re-runs the build and re-syncs. S3 versioning (if the bucket
  has it) is a manual fallback, not an automated one.

### `___ENV_CHANGES___`

- **EC2 path**: update the parameter in Parameter Store
  (`/{app-name}/prod/{VAR_NAME}`, `aws ssm put-parameter --overwrite`),
  then trigger a normal deploy — `app-pipeline-deploy.sh` regenerates
  `.env` from Parameter Store as part of every deploy, so a fresh deploy
  is all that's needed, not a manual file edit. Repeat the `NEXT_PUBLIC_*`
  caveat here too if relevant — it's easy to forget mid-troubleshooting.
- **Static-site path**: change the CodeBuild env var or GitHub Actions
  secret, then trigger a deploy — there's no running process to reload,
  only a rebuild.

### `___COMMON_FAILURES___`

Pull directly from `references/gotchas.md`, filtered to what's actually
relevant to this app's configuration (don't include the CodeDeploy-agent
explanation if this app never touches that decision, for instance — though
in practice most of gotchas.md applies broadly to the EC2 path). For the
static-site path, most of gotchas.md doesn't apply — the real failure modes
there are more like "CORS misconfigured for the actual origin" or "cache
not invalidated, seeing stale content" — describe those instead of forcing
EC2-specific gotchas into a doc for an app that doesn't use EC2.
