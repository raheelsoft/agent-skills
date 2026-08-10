---
name: app-pipeline-setup
description: Provisions AWS infra and a CI/CD pipeline (AWS CodePipeline or GitHub Actions) for a Node.js app (a NestJS/Express-style backend or any Node-servable frontend — Next.js, Nuxt, SvelteKit, Remix, a custom server, not just Next.js), public or private repo (a per-app SSH deploy key is generated on-box for private repos, see references/deploy-key-setup.md), single-package or monorepo, deploying to an EC2 instance via SSM RunCommand instead of the CodeDeploy agent, with an automatic release/rollback pattern (concurrency-safe, no overlapping deploys), a zero-downtime pm2 cluster-mode restart by default for both frontend and backend (asked explicitly, not assumed — see references/zero-downtime-restarts.md), optional managed RDS database, automated Postgres backups to a private S3 bucket (scheduled pg_dump, encrypted, auto-expiring, proven restorable) for local-Postgres/external database setups, S3 bucket(s), CloudWatch alarms/notifications, continuous uptime monitoring via Route53 health checks, a staging environment with its own correctly-labeled Parameter Store tree, optional HTTP Basic Auth gating on a path (e.g. API docs public on dev, restricted on prod — see references/basic-auth-gating.md), secure-by-default infra (security group never opens the app or database port, local Postgres forced to listen on localhost, a pre-provisioning npm audit pass surfaced before the confirmation gate, an active recommendation to gate an admin-panel-shaped app behind Basic Auth/IP-allowlist — see references/secure-defaults.md), a combined-host path-based routing option for a frontend+backend pair sharing one instance and one domain (the lowest-cost two-app shape — see templates/app/nginx-combined.conf.tmpl), automatic Route53 DNS record creation when the domain is on AWS (or a records-to-add report for GoDaddy/Cloudflare/Namecheap/other external providers), a static-export-to-S3+CloudFront alternative for frontends that don't actually need a server, a local-dev env report (S3 creds, DB connection info) for developers who need to run the app on their own machine, rough monthly cost estimates, teardown guidance for decommissioning, and a security-audit/incident-response flow (references/security-audit.md, references/incident-response.md) for checking or cleaning up an existing instance — reachable-process/persistence checks, security-group-vs-listening-port exposure cross-checks, database access-control checks, SSH posture, exposed-admin-panel checks, and dependency-vulnerability checks, plus containment steps (kill/clean/stopgap watchdog/find-the-entry-point) if something active turns up. Use when the user says "set up a pipeline for this app", "deploy this to AWS", "bootstrap infra for this project", "tear down"/"decommission" one previously set up, "why is my site down, can you check the server", "audit/check the security of this instance", or asks to turn manual AWS deploy work into a repeatable pipeline. Hard rule — always confirm with the user before creating any new AWS resource, showing exactly what will be created; never invent this rule away even mid-troubleshooting.
---

# App Pipeline Setup

Interviews the user, then provisions AWS infrastructure and a CI/CD pipeline
for the app in the current (or a given) repo directory — generalized from a
proven, hand-built setup. Assumes only that `aws configure` has already been
run; this skill does everything else.

All templates live in `templates/` relative to this file
(`~/.claude/skills/app-pipeline-setup/templates/`), rendered via
`scripts/render.sh`. Read `references/gotchas.md` once at the start of a run
— it documents every real failure mode already hit building the original
version of this pipeline, so they don't get rediscovered from scratch. The
other `references/*.md` files are pointed to inline below, at the step each
one is relevant to.

If the user is asking to **decommission/tear down** something this skill
previously created, rather than create something new, that's a different
flow entirely — go straight to `references/teardown.md` instead of Step 1.

If the user is asking to **check, audit, or investigate the security** of
an instance — including "why is my site down, can you check the server,"
which very often turns into exactly this — that's also a different flow:
go straight to `references/security-audit.md`. It applies to any
instance reachable via SSM/SSH, not just ones this skill provisioned. If
the audit turns up an active compromise (not just an exposure), switch to
`references/incident-response.md` for containment and follow-up.

## Step 1 — Preconditions

- `aws sts get-caller-identity`. If this fails, stop and tell the user to
  run `aws configure` first — do not attempt to provision anything without
  working credentials.
- Confirm the current directory (or a path the user gives) is a git repo for
  the app being deployed. If not, ask for the path.
- Note whether `package-lock.json` exists in the target repo — this decides
  `npm ci` (lockfile present) vs `npm install` (absent) throughout.
- Run `npm audit` (or `npm audit --omit=dev` if noise from dev-only tooling
  isn't relevant to what's about to be internet-facing) on the target repo
  and tell the user the `high`/`critical` count now, before provisioning
  anything — a real production compromise's most defensible root cause,
  once other theories were ruled out, was exactly this: known, unpatched
  `high`/`critical` CVEs in the app about to go live. This doesn't block
  the setup (a decision to patch first or deploy now and patch after is
  the user's to make), but it must not go unmentioned before Step 3's
  confirmation gate — carry the count into that manifest.
- Check for existing deploy artifacts: `appspec.yml`, `buildspec.yml`,
  `.github/workflows/deploy.yml`, or any of
  `scripts/{before_install,after_install,application_start,validate_service}.sh`.
  Finding any of these means this app already has *some* deploy mechanism —
  whether from an earlier run of this skill or a hand-built one that
  predates it — and this run is very likely **adding an environment**
  (staging/dev) to it, not starting fresh. See Step 2's first question
  below before assuming a greenfield setup; `references/staging-environment.md`
  has the full existing-infra flow.

## Step 2 — Interview

### 2a-pre. Existing infra check (only if Step 1 found deploy artifacts)

Ask via `AskUserQuestion` before anything else: **add a new environment
(staging/dev) alongside what's already there** vs **replace/rebuild the
deploy setup from scratch**. Rebuild is rare and destructive-adjacent —
treat an explicit yes here the same as Step 3's confirmation gate, not a
default. For "add a new environment," everything below still runs
normally (new EC2 instance, new pipeline, new Parameter Store tree, per
`references/staging-environment.md`) — the only thing that changes is
Step 8: never silently render this skill's own generic hook scripts over
whatever's already in `scripts/*.sh`. Skip straight to Step 2a once
answered.

### 2a. App type first, then (frontend only) the static-export analysis

Before asking anything else, determine the app type — **NestJS/Node API
backend** vs **Next.js frontend** vs **other Node app**. If it's a
frontend, run the analysis in `references/static-site-conversion.md`
*before* asking any EC2-specific questions below — it decides whether
those questions even apply:

- Search the repo for static-export blockers (API routes, middleware,
  `getServerSideProps`, uncontrolled ISR, unoptimized `next/image` usage,
  Server Actions).
- If none found, or the ones found are genuinely minimal to fix (see the
  reference doc's exact bar for "minimal"), ask via `AskUserQuestion`:
  **convert to static export + deploy on S3+CloudFront** vs **deploy on
  EC2 intentionally**. Name the specific changes needed, if any, so the
  choice is informed. Never convert without an explicit yes, and never
  skip this question just because the app "could" be static — EC2 is a
  completely valid intentional choice.
- If real blockers exist, don't ask — tell the user why (specifically,
  which blockers) and proceed with the EC2 path.

If **static-site path chosen**: skip the rest of Step 2 entirely except
app identity (name/slug), GitHub owner/repo/branch, and the domain/DNS
questions in 2c below — none of the EC2/process-model/database questions
apply. Jump to "Static-site path" (after Step 12) once Steps 1-3 are done.
If **EC2 path** (backend, other Node app, or a frontend that chose EC2
intentionally), continue with the batches below.

### 2b. EC2-path questions

Use `AskUserQuestion`, batched into as few calls as possible (the tool
supports up to 4 questions per call, up to 4 calls — use multiple calls
rather than cramming unrelated questions into one, but don't ask one
question per call either):

**Batch 1 — shape of the setup:**
- CI mechanism: **AWS CodePipeline** vs **GitHub Actions**
- Process model: **pm2** (default) vs **Docker** (only offer this if the
  repo already has a `Dockerfile`/`docker-compose.yml` — see
  `references/docker-option.md`; don't scaffold one to enable this path)
- Infra scope: **provision a brand-new EC2 instance** vs **target an
  existing instance ID** (skip Step 4 entirely if existing — and if the
  existing instance already hosts a sibling app for the same product, see
  Step 2c's combined-host question below). Targeting an existing instance
  means inheriting whatever's already on it, good or bad — a quick pass
  through `references/security-audit.md` before adding a new app to one
  is worth doing, not just assumed safe because it's already running.
- **Is the repo private?** If yes, Step 8's initial checkout needs a
  per-app SSH deploy key set up first — see `references/deploy-key-setup.md`
  for why this is needed regardless of which CI mechanism was just chosen
  (neither one gives the box itself anything to authenticate a git clone
  with). Public repos skip this entirely.

**Batch 2 — app identity & new-instance specifics:**
- App identity: app name/slug (used to name every AWS resource — keep it
  short, lowercase, hyphenated, and **globally unique across every
  engagement this skill is ever used for**, e.g. `acme-api` not `api` —
  every stack, IAM role, and S3 bucket is named from this value alone,
  account-and-region-wide, so a generic name risks colliding with an
  unrelated app from a different engagement; Step 3's confirmation gate
  double-checks this, but a unique name up front avoids that check ever
  firing), port the app listens on, health-check path (offer to scaffold a
  trivial one if the repo doesn't have one — see Step 8)
- App subdirectory: is this app at the repo root (the common case, leave
  blank) or in a subdirectory of a monorepo (e.g. `apps/backend`)? Carried
  into Step 8's placeholder fills for `buildspec.yml` and the hook scripts.
- Backend only: is this app safe to run as more than one concurrent OS
  process (cluster mode — the zero-downtime-deploy default)? See
  `references/zero-downtime-restarts.md` for exactly what to check
  (in-memory rate limiting/caching, in-process cron, non-adapter-backed
  WebSocket state) before answering yes by default.
- Frontend only: production start command, after `npm run build` — check
  `package.json`'s `scripts.start` first and suggest it as the default
  rather than asking blind (Next.js's `next start` is a common answer, not
  the only one — see `references/frontend-framework-support.md`).
- GitHub owner/repo/branch that should trigger deploys (default `main`)
- If new instance: **EC2 instance type — always ask explicitly, never pick
  silently.** Offer `t3.micro` (small apps, needs the swap file the
  template already adds), `t3.small`, `t3.medium`, or "other"; AWS region;
  SSH access — a CIDR to allow (e.g. office/VPN IP) or "no SSH, SSM only"
  (recommended default, never defaults to `0.0.0.0/0`); **Elastic IP —
  stable IP (recommended, especially if a domain is planned — the default
  dynamic public IP changes on stop/start and silently breaks DNS) vs the
  subnet's auto-assigned dynamic IP (fine for a short-lived instance with
  no domain).** Also ask explicitly, don't default silently either way.

**Batch 3 — data, storage, and environment:**
- Database: **none**, **local Postgres/Redis on the box** (cheapest, no
  backups unless the next question opts in), **managed RDS Postgres**
  (recommended for anything beyond a throwaway/staging app — see
  `references/rds-database.md`), or **external/already have one** (just
  need the connection string field). Local Postgres/Redis is never reachable
  from outside the box under this skill's defaults — bound to localhost, no
  security-group rule for 5432/6379 — and that's a hard invariant, not a
  setting to loosen for "just temporary remote debugging" even if asked; use
  an SSM port-forward session instead (see `references/secure-defaults.md`).
- Automated database backups (only ask if Database above is **local
  Postgres/Redis** or **external** — skip for **none**, and for **RDS**
  point out it already has its own `BackupRetentionPeriod`, no separate
  setup needed): **yes, twice daily** (recommended default — a 12h
  worst-case data-loss window is a sane balance of RPO vs. storage/CPU cost
  for most apps; see `references/db-backups.md` for the reasoning and the
  3x-daily/once-daily alternatives), **yes, different schedule** (get the
  exact frequency/cron schedule from the user directly), or **no**. If yes,
  also confirm the retention window (default 7 days — how long backups are
  kept before automatic deletion) rather than assuming it.
- S3 bucket: **none**, **private** (presigned-URL access only), **public**
  (public reads, for directly-servable assets — offer CloudFront in front
  of it, see `references/s3-bucket-setup.md`), or **both**
- Environment: **production only** vs **production + staging** (see
  `references/staging-environment.md` if the latter) — either way, confirm
  what this specific run's environment is actually called (`prod` by
  default; `staging`/`dev`/whatever the team calls it for a second run).
  This becomes Step 8's `<app-dir>/.environment` file and the second
  segment of every Parameter Store path
  (`/{app-name}/{environment}/{VAR}` — see
  `references/env-parameter-store.md`) — never left to default silently
  for a non-production run, since a forgotten answer here means that
  run's secrets get written under a path segment literally spelled `prod`.
- Restrict any path behind HTTP Basic Auth (e.g. a backend's `/api/docs`
  on prod, left public on dev/staging)? If yes: get the path(s) and a
  username (default `admin`) — **not** the password, which follows Step
  9's normal secrets flow instead (see `references/basic-auth-gating.md`).
  Ask this per environment, not once for the whole app — expect different
  answers for prod vs dev/staging.
  - If the app being deployed **is itself** an admin/internal panel (not
    just an API with one restricted path) — an admin dashboard, a CMS, an
    ops console — don't just ask this neutrally: actively recommend gating
    the whole thing behind Basic Auth and/or an IP allowlist (`satisfy any;
    allow <cidr>; deny all;` alongside `auth_basic`, see
    `references/basic-auth-gating.md`), and say why: a real production
    compromise's most likely entry point was exactly this shape — a fully
    public admin panel running an outdated framework version with known
    CVEs. Still their call to decline, but don't let it default to "public,
    no gate" without at least surfacing the recommendation.

**Batch 4 — operational (whenever any new infra is being created, EC2 or
static-site):**
- Notification email for deploy failures + disk/status alarms (leave blank
  to skip — see `references/notifications.md`); if a domain is given for
  nginx+TLS, also ask for the certbot renewal email now, don't default it
  to something guessed
- Continuous uptime monitoring: yes/no — a Route53 health check + alarm
  independent of deploy-time validation (see
  `references/uptime-monitoring.md` for why this is worth asking about —
  nothing else in this skill continuously checks the app is still up
  hours/days after a successful deploy). Only relevant if a domain, or (EC2
  path) a stable Elastic IP, exists to check against — a dynamic IP isn't
  useful here since the check's target is pinned at creation time and would
  silently start monitoring the wrong address after the instance restarts.
- Project/client tag value (for cost tracking if this skill is reused
  across multiple engagements) — a short identifier is enough, doesn't need
  its own question if the user already gave one implicitly via the app name

### 2c. Domain/DNS (both paths, only if a domain is in play)

- **Combined-host check first, if Batch 1 targeted an existing instance**:
  does that instance already host a sibling app for the same product (a
  backend when this run is a frontend, or vice versa)? If so, ask whether
  this app should share that sibling's domain via path-based routing
  (`templates/app/nginx-combined.conf.tmpl` — one instance, one domain,
  one cert, cheaper — see `references/cost-estimates.md`) instead of
  getting its own domain/subdomain. If sharing: skip the rest of this
  section (no new domain/DNS record needed, the sibling's already covers
  it) and jump to Step 11's combined-host branch. If not sharing (or no
  sibling exists), continue below as normal.
- Ask whether this app needs a custom domain at all — skip the rest if not.
- If yes: also ask whether a second domain should work too — most commonly
  the apex + `www` pair (`example.com` and `www.example.com`). Both
  templates support exactly one secondary domain alongside the primary
  (not an arbitrary list — this covers the common case without needing
  CFN-level loops for certificate validation). Leave blank for a single
  domain, the common case for an internal/API-only app.
- Ask where DNS for that domain is managed — **Route53 (AWS)** or
  **elsewhere**. "Elsewhere" covers any provider (GoDaddy, Cloudflare,
  Namecheap, Google Domains, etc.) — this decides whether the skill
  creates the DNS record itself (Step 11 for EC2, SS3 for the static-site
  path) or hands back a records-to-add report instead — see
  `references/dns-route53.md`.
- If "elsewhere": ask which provider (GoDaddy / Cloudflare / Namecheap /
  other) as a quick follow-up — not required to proceed, but lets the
  eventual records report give provider-correct navigation and flag
  Cloudflare's proxy gotcha specifically (see the provider table in
  `references/dns-route53.md`) instead of only generic instructions.
- If Route53: check for an existing hosted zone before assuming one needs
  to be created (`references/dns-route53.md` has the exact command).

Don't guess at any of these — if an answer is ambiguous or the user gives a
value that doesn't fit an expected pattern (e.g. an app name with
uppercase/spaces), ask again rather than silently normalizing it.

## Step 3 — Confirmation gate (hard rule)

**Collision check first**: `aws cloudformation describe-stacks
--stack-name <app-name>-instance` (and every other stack name about to be
used — `-pipeline`, `-db`, `-s3`, etc.). `describe-stacks` erroring
"does not exist" is the expected, good outcome — proceed normally. If any
of them **do** exist and this run didn't already know about them (e.g.
this isn't a deliberate "add staging to an existing app" or "update"
run), stop and confirm with the user before going any further — an
unexpected existing stack under the chosen `AppName` almost always means
the name collided with an unrelated app, since `aws cloudformation
deploy` against an existing stack name updates it rather than erroring
(see `references/gotchas.md`'s "Two different engagements picking the
same AppName silently collide"). Don't let this check silently pass
through to a `deploy` call that would clobber someone else's stack.

Before creating **anything**, print the exact manifest of AWS resources
about to be created — not a vague "can I use AWS" ask, a concrete list:

- EC2 instance (**exact instance type and region**) + security group, if
  new infra was chosen — whether SSH is open (and to which CIDR) or fully
  closed, and whether it gets a stable Elastic IP or the subnet's dynamic
  one (say which was chosen, don't just assume Elastic IP). State the
  security group's scope plainly regardless: only 80/443 (and 22 if a CIDR
  was given) — never the app's own port or a database port, see
  `references/secure-defaults.md`.
- Dependency vulnerability check (Step 1's `npm audit` pass) — surface the
  result here too if it found anything `high`/`critical`, not just at Step
  1 where it's easy to scroll past, so the user's yes is actually informed
  by it
- RDS instance (**exact instance class**, MultiAZ or not, backup retention),
  if a managed database was chosen
- IAM roles: instance role, CodeBuild build/deploy roles or the GitHub OIDC
  deploy role
- CodeStar Connection, if AWS CodePipeline was chosen and none is reusable
- S3 bucket(s), if requested — say which (private/public/both), the IAM
  user that goes with them, and whether CloudFront was requested
- Database backup bucket + lifecycle rule, if automated backups were
  requested — the retention window chosen, and that it adds one scoped
  `s3:PutObject`-only inline policy to the instance's existing role (no new
  role/user)
- SNS topic, if a notification email was given
- Route53 health check + alarm, if continuous uptime monitoring was
  requested — note it's a continuously-running billable resource, not a
  one-time cost like most of the line items above
- **Static-site path**: the site S3 bucket + CloudFront distribution, an
  ACM certificate (if a custom domain was given, and remind them it's
  created in us-east-1 specifically), and the pipeline/OIDC role for that
  path — a completely different resource set from the EC2 line items above,
  don't conflate the two in the manifest
- **DNS**: a new Route53 hosted zone if one doesn't already exist (with the
  nameserver-update caveat spelled out — see `references/dns-route53.md`),
  and/or the DNS record(s) themselves
- If a staging environment was requested, make clear this is a **second,
  full copy** of the above, not an extra line item

Include a rough monthly cost estimate alongside the manifest — see
`references/cost-estimates.md` for the per-resource numbers and how to
phrase it (a range with the on-demand/rough caveat, not a bare number that
reads like a quote). A resource list without any sense of what it costs is
a weaker basis for a yes than one with it.

Wait for an explicit yes before proceeding. This gate applies every time
this skill runs, not just the first time — a second app (or a staging
environment for the same app) still needs its own confirmation.

## Step 4 — Provision EC2 (only if "new instance" was chosen)

Skip this step entirely (and Steps 7-11 below) for a frontend using the
static-site path from Step 2a — jump to "Static-site path" after Step 12
instead. Everything in Steps 4-12 is EC2/pm2-path only.

1. Look up a VPC/subnet if the user didn't give one:
   `aws ec2 describe-vpcs --filters Name=is-default,Values=true` and a
   public subnet within it.
2. Deploy `templates/cfn/ec2-instance.yaml` (add `--tags Project=<value>`
   from Step 2's Batch 4 answer — CloudFormation stack-level tags propagate
   to every taggable resource the stack creates automatically):
   ```
   aws cloudformation deploy --region <region> \
     --stack-name <app-name>-instance \
     --template-file templates/cfn/ec2-instance.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags Project=<project-tag-value> \
     --parameter-overrides AppName=<app-name> VpcId=<vpc> SubnetId=<subnet> \
       InstanceType=<type> NeedsPostgres=<true|false> NeedsRedis=<true|false> \
       EnableDocker=<true|false> SshCidr=<cidr-or-empty> \
       AssignElasticIp=<true|false, per Step 2's answer> \
       NotificationTopicArn=<arn-or-empty, from Step 5b if created>
   ```
3. **No separate polling step needed** — `aws cloudformation deploy` itself
   blocks until UserData finishes and signals success via `cfn-signal`
   (`CreationPolicy` on the `Instance` resource), or fails the stack
   outright if bootstrap errors or exceeds `BootstrapTimeoutMinutes`
   (default 20). The command above simply doesn't return until bootstrap
   is actually done — that's the wait, not something to add on top of it.
   If it's ever useful to check bootstrap status independently (debugging,
   or after the fact), `/home/<os-user>/.app-pipeline-bootstrap-complete`
   still gets touched at the end as a manual-inspection marker, but it's
   not the primary mechanism.
4. Read the stack outputs (`InstanceId`, `PublicIp`, `SecurityGroupId`) —
   needed for every later step, including the RDS/S3 stacks below. Use
   `PublicIp` everywhere "the instance's public IP" is needed (it's always
   populated — the Elastic IP if `AssignElasticIp=true`, otherwise the
   subnet's auto-assigned dynamic IP); `ElasticIp` is a separate output
   that only exists when `AssignElasticIp=true`, for the rare case
   something specifically needs to confirm the IP is guaranteed stable.

## Step 5 — Provision database and notifications (only if requested)

### 5a. Notifications (do this first if a notification email was given)
Deploy `templates/cfn/notifications.yaml`:
```
aws cloudformation deploy --region <region> \
  --stack-name <app-name>-notifications \
  --template-file templates/cfn/notifications.yaml \
  --tags Project=<project-tag-value> \
  --parameter-overrides AppName=<app-name> NotificationEmail=<email>
```
Read the `TopicArn` output — pass it into Step 4's `NotificationTopicArn`
param (redeploy the EC2 stack if it was already created) and into Step 7's
pipeline/GitHub Actions setup. Tell the user the email subscription needs a
one-time confirmation click before alerts start delivering.

### 5b. Database
- **Local Postgres/Redis**: already handled by Step 4's
  `NeedsPostgres`/`NeedsRedis` params, including the `listen_addresses`
  hardening baked into the template's UserData. Worth one quick check over
  SSM rather than assuming it took effect — `grep listen_addresses
  /etc/postgresql/*/main/postgresql.conf` should show `localhost`, and `ss
  -tlnp | grep 5432` should show it bound to `127.0.0.1`, not `0.0.0.0` —
  cheap to confirm now, expensive to discover later (see
  `references/secure-defaults.md`).
- **Managed RDS**: deploy `templates/cfn/rds-instance.yaml`
  (`references/rds-database.md` has the full flow):
  ```
  aws cloudformation deploy --region <region> \
    --stack-name <app-name>-db \
    --template-file templates/cfn/rds-instance.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --tags Project=<project-tag-value> \
    --parameter-overrides AppName=<app-name> DatabaseName=<app_name_with_underscores> \
      VpcId=<vpc> SubnetIds=<subnet-1>,<subnet-2> \
      AppInstanceSecurityGroupId=<SecurityGroupId from Step 4> \
      DBInstanceClass=<class> MultiAZ=<true|false> \
      BackupRetentionPeriod=<days> DeletionProtection=<true|false>
  ```
  Read `Endpoint`/`Port`/`MasterUserSecretArn`/`DatabaseName` outputs, then
  `aws secretsmanager get-secret-value --secret-id <MasterUserSecretArn>`
  to get the username/password RDS generated — build `DATABASE_URL` from
  these and carry it into Step 9, where it becomes its own
  `/{app-name}/{environment}/DATABASE_URL` parameter. Never print the password
  anywhere else after this.
- **External/already have one**: just get the connection string from the
  user for Step 9 — nothing to provision.

## Step 6 — Provision S3 bucket(s) (only if requested)

1. Deploy `templates/cfn/s3-bucket.yaml`:
   ```
   aws cloudformation deploy --region <region> \
     --stack-name <app-name>-s3 \
     --template-file templates/cfn/s3-bucket.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags Project=<project-tag-value> \
     --parameter-overrides AppName=<app-name> BucketVisibility=<private|public|both> \
       AllowedOrigins=<comma-delimited list, e.g. https://app.example.com,http://localhost:3000> \
       EnableCloudFront=<true|false>
   ```
2. Read the stack outputs (`AppUserName`, and whichever of
   `PrivateBucketName`/`PublicBucketName`/`PublicBucketUrl`/
   `CloudFrontDomainName` were created).
3. Mint an access key imperatively — **not** via CFN Outputs (see
   `references/s3-bucket-setup.md` for why):
   ```
   aws iam create-access-key --user-name <AppUserName from step 2>
   ```
   Capture `AccessKeyId`/`SecretAccessKey` from this command's own output —
   this is the only place they're ever shown. Carry them into Step 9,
   where each becomes its own parameter
   (`/{app-name}/{environment}/AWS_ACCESS_KEY_ID`, etc.); never print the secret
   again anywhere else.
4. If a private bucket exists and the target repo already has S3 upload
   code, check it for a hardcoded public-ACL write (e.g. `ACL:
   'public-read'`) before wiring this bucket in — it will fail against
   Block Public Access. Flag it to the user rather than patching their
   application code yourself.

## Step 7 — CI-mechanism-specific setup

### AWS CodePipeline path
1. Check for a reusable CodeStar Connection
   (`references/codestar-connection-setup.md`); if none, walk the user
   through the one-time console OAuth step and poll until `Available`.
2. Render + deploy `templates/cfn/pipeline.yaml`:
   ```
   aws cloudformation deploy --region <region> \
     --stack-name <app-name>-pipeline \
     --template-file templates/cfn/pipeline.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags Project=<project-tag-value> \
     --parameter-overrides AppName=<app-name> GitHubOwner=<owner> \
       GitHubRepo=<repo> GitHubBranch=<branch> \
       CodeStarConnectionArn=<arn> InstanceId=<id> \
       AppDir=/home/ubuntu/apps/<app-name> \
       NotificationTopicArn=<arn-or-empty>
   ```
   `BuildTimeoutMinutes`/`DeployTimeoutMinutes` default to 20/35 — sized for
   a small app. For a larger repo/monorepo, raise these explicitly rather
   than letting a build silently fail on timeout the first time someone
   hits it. `CodeBuildImage`/`BuildComputeType` also have sensible defaults
   (pinned `standard:7.0`, `BUILD_GENERAL1_SMALL`) — raise `BuildComputeType`
   for a heavy build (large monorepo, expensive type-checking), and revisit
   `CodeBuildImage` if this stack hasn't been touched in a long time (AWS
   periodically deprecates old CodeBuild images).

### GitHub Actions path
1. Check/create the OIDC provider (`references/github-oidc-setup.md`) —
   this itself is a new-resource creation, covered by the Step 3 gate if not
   already confirmed.
2. Render + deploy `templates/cfn/github-oidc-role.yaml` with the same
   `AppName`/`GitHubOwner`/`GitHubRepo`/`GitHubBranch`/`InstanceId` params.
3. Read the `DeployRoleArn` output.
4. Render `templates/github-actions/deploy.yml.tmpl` → `.github/workflows/deploy.yml`
   in the target repo via `scripts/render.sh`, filling in the role ARN,
   instance ID, app dir, region, branch, the install/lint commands for the
   chosen app type, `DEPLOY_TIMEOUT_MINUTES` (same value/reasoning as
   `pipeline.yaml`'s `DeployTimeoutMinutes` — default 35, raise for a
   heavier app), and `NOTIFICATION_TOPIC_ARN` (empty string if none — the
   workflow's failure-notification step is skipped when empty).

## Step 8 — Render app-side files into the target repo

Use `scripts/render.sh <template> <output> KEY=value ...` for each of:
`buildspec.yml` (backend or frontend variant), `appspec.yml`,
`scripts/{before_install,after_install,application_start,validate_service}.sh`.

**If Step 2a-pre found existing hook scripts** (adding an environment to
infra that already has some deploy mechanism), do not render over them
silently — `app-pipeline-deploy.sh` (Step 4) just does
`cd "$RELEASE_DIR" && bash scripts/before_install.sh` etc., so it doesn't
care who originally wrote these or what orchestrated them (CodeDeploy, a
hand-built `deploy.sh`, an earlier run of this skill) — but it does
require them to actually run correctly from *whatever directory it `cd`s
into*, which is a per-deploy `releases/<sha>/` directory, not a fixed
path. Read the existing scripts and check for **two independent**
incompatibilities — a script can fail either one alone, or both:

1. **Hardcoded absolute app path** (e.g. `cd /home/<user>/apps/<app-name>`
   at the top) — a script that always operates on one fixed directory
   defeats this skill's atomic release/rollback model, since it wouldn't
   be touching the release dir at all.
2. **Hardcoded environment name/literal** anywhere in the script — most
   commonly a Parameter Store path like `/{app-name}/prod/` baked in
   directly, but also watch for an environment-specific DB name, S3
   bucket name, or hostname/URL written as a literal. Reused as-is on a
   new environment's box, this silently points the new environment at
   **prod's** resources (parameters, database, bucket) instead of its
   own — a correctness and potential secrets-leak issue, not just an
   atomicity one, and easy to miss because the script still *runs*
   without error.

Ask via `AskUserQuestion`:
- **Reuse as-is** (only offer this if *neither* check above found
  anything — the script is both relocatable and environment-agnostic, so
  it's safe to run per-release, per-environment, unmodified)
- **Adapt minimally** (fix whichever check(s) failed: strip the
  hardcoded `cd`/path, since `app-pipeline-deploy.sh` already puts you in
  the release directory before invoking these; and/or replace the
  hardcoded environment literal with a variable — e.g. an `APP_ENV`
  exported once upstream, defaulting to `prod` so existing prod behavior
  is unchanged — the rest of the script's logic usually needs no other
  change)
- **Render fresh generic templates instead** (re-fill this step's
  placeholders below to match what the existing scripts actually do —
  Prisma/seed commands, entrypoint path, etc. — accepting that this
  environment's scripts will then differ in form, though not behavior,
  from the existing ones)

Never guess silently between these — a wrong guess either breaks the new
environment's atomicity/rollback invisibly (reuse-as-is on a
non-relocatable script), points it at prod's own resources invisibly
(reuse-as-is on a script with a hardcoded environment literal), or
diverges its behavior from prod without the user noticing (rendering
fresh generic ones that miss an app-specific step). If none of Step 1's
existing-artifact checks found anything, proceed with rendering as
normal — nothing above applies.

- **pm2 process model**: also render `ecosystem.config.js` (backend or
  frontend variant).
- **Docker process model**: render `after_install.docker.sh.tmpl` and
  `application_start.docker.sh.tmpl` instead of the pm2 `after_install`/
  `application_start` variants, and skip `ecosystem.config.js` entirely —
  see `references/docker-option.md`.
- `scripts/deploy/deploy.sh` (from `deploy.sh.tmpl`) is optional — a
  manual/debug helper, not part of the real deploy path (see the template's
  own header comment). Render it if the user wants it for local debugging.

Key placeholder values to fill in:
- `___APP_NAME___`, `___APP_DIR___` (`/home/<os-user>/apps/<app-name>`),
  `___OS_USER___` (default `ubuntu`)
- `___INSTALL_CMD___` = `npm ci` or `npm install` per Step 1's lockfile check
- `___NODE_MAJOR___` (both `buildspec.yml` variants — same Node major
  version installed on the instance in Step 4, default `24`)
- `___DEFAULT_PORT___`, `___HEALTH_PATH___`
- `___CD_SUBDIR___` (`buildspec.yml`) / `___SUBDIR_SETUP___`
  (`after_install.sh`): from Step 2b's App subdirectory answer. Blank
  answer (repo-root app, the common case) → `___CD_SUBDIR___` = `true`
  (a no-op command, not an empty string — this sits inside a YAML
  commands list, so it needs to still be a valid list item) and
  `___SUBDIR_SETUP___` = empty string. A given subdirectory (e.g.
  `apps/backend`) → `___CD_SUBDIR___` = `cd "apps/backend"`, and
  `___SUBDIR_SETUP___` = the 3-line block from the template's own comment
  (`RELEASE_ROOT="$(pwd)"`, `cd "apps/backend"`, then relink `.env` from
  `$RELEASE_ROOT` — `.env` is only ever symlinked into the release root by
  `app-pipeline-deploy.sh`, never into a subdirectory).
- `___APP_CWD___` (`ecosystem.config.js`, both variants): `___APP_DIR___/current`
  for a repo-root app, or `___APP_DIR___/current/<subdir>` when Step 2b
  gave a subdirectory.
- Backend only: `___PRISMA_GENERATE_CMD___`/`___PRISMA_MIGRATE_CMD___` (empty
  string if the app doesn't use Prisma), `___SEED_CMD___` (empty string
  unless the user has an idempotent seed script — do **not** wire up a
  non-idempotent or demo-data seeder into a deploy hook; ask first if
  unsure, same caution as the original discovery-town build), `___NODE_HEAP_MB___`
  (2048 is a reasonable default for a t3.micro), `___BACKEND_ENTRYPOINT___`
  (check the repo's actual build output path, e.g. `dist/main.js` vs
  `dist/src/main.js` — don't assume), `___BACKEND_INSTANCES___`/
  `___BACKEND_EXEC_MODE___` (`2`/`cluster` by default, `1`/`fork` only if
  Step 2b's cluster-safety question came back no — see
  `references/zero-downtime-restarts.md`)
- Frontend only: `___FRONTEND_START_SCRIPT___`/`___FRONTEND_START_ARGS___`
  (from Step 2b's production-start-command answer — see
  `references/frontend-framework-support.md`), `___FRONTEND_INSTANCES___`/
  `___FRONTEND_EXEC_MODE___` (`2`/`cluster` by default, same reasoning as
  the backend's)
- `___LINT_CMD___`: use the repo's real lint script if one exists and
  actually runs (verify it, don't assume `npm run lint` works — see the
  lockfile/eslint-config caution in `references/gotchas.md`); otherwise a
  no-op placeholder comment, never invent a lint config unilaterally
- `___RESTRICTED_LOCATION_BLOCK___` (`nginx.conf.tmpl`/
  `nginx-combined.conf.tmpl`, filled at Step 11 not here — listed for
  completeness since it's the same render.sh mechanism): empty string
  unless Step 2's Basic Auth question was yes, see
  `references/basic-auth-gating.md`

Before writing, check whether a health-check endpoint already exists at the
chosen path. If not, tell the user exactly what to add (a one-line
liveness route) rather than silently injecting application code into their
repo.

Also check `.gitignore` for a `.env` entry. If missing, tell the user
before Step 9 places real credentials on the box — a `.env` that isn't
gitignored is one `git add .` away from a committed secret, independent of
anything this skill does correctly elsewhere. Add the entry only with
their OK, same as any other repo-content change.

### One-time: initialize the checkout on the box

`/usr/local/bin/app-pipeline-deploy.sh` (installed on the instance in Step 4)
only `git fetch`es an existing checkout — it doesn't clone one, and it
authenticates as whatever `<app-dir>/repo`'s `origin` remote was cloned
with. Before the first deploy:

1. **Write the environment marker**: `echo <environment, from Step 2's
   answer, default "prod"> | sudo -u <os-user> tee <app-dir>/.environment`
   — read by `app-pipeline-deploy.sh` on every deploy to pick the right
   Parameter Store tree (`references/env-parameter-store.md`). Skip only
   if the environment is genuinely `prod` and always will be for this app
   — the file's absence already defaults to `prod`, so writing it
   explicitly for a `prod` run is optional, not wrong either way.
2. **Private repo only**: set up a per-app SSH deploy key first — see
   `references/deploy-key-setup.md` for the full command sequence and why
   this is needed regardless of which CI mechanism was chosen. Skip this
   entirely for a public repo.
3. **Clone**:
   ```
   aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
     --parameters commands="['sudo -u <os-user> mkdir -p <app-dir>/releases', 'sudo -u <os-user> git clone --branch <branch> <repo-url> <app-dir>/repo']"
   ```
   `<repo-url>` is `https://github.com/<owner>/<repo>.git` for a public
   repo, or `git@github.com:<owner>/<repo>.git` (with the
   `GIT_SSH_COMMAND` wrapper from step 2) for a private one.

See `references/release-rollback.md` for the full release-directory model,
how the automatic rollback-on-failed-validation works, and what happens on
every subsequent deploy.

## Step 9 — Store env vars in Parameter Store (the source of truth)

**SSM Parameter Store is where env vars actually live — not a backup of a
file on the box.** Each variable is its own real, individually-named
parameter (`/{app-name}/{environment}/{VAR_NAME}`, e.g.
`/myapp/prod/DATABASE_URL`, `/myapp/prod/JWT_SECRET` — `{environment}` is
whatever Step 2 gave for this run, `prod` by default, never hardcoded —
see `references/env-parameter-store.md`) — never one opaque blob. `.env`
on the instance is a *generated artifact*:
`/usr/local/bin/app-pipeline-deploy.sh` (installed in Step 4) fetches
every parameter under `/{app-name}/{environment}/` (reading the
environment from `<app-dir>/.environment`, written in Step 8) and
reassembles `.env` fresh on **every** deploy (see
`references/env-parameter-store.md` and `references/release-rollback.md`).
Changing a var going forward means updating its parameter, then
triggering a deploy — not SSH/SSM-editing a file in place.

0. **Ask first how the user wants these populated — never assume "paste it
   in chat."** Use `AskUserQuestion`:
   - **Paste values now** (fastest, good default for a first deploy) — the
     user pastes real `.env` content in this conversation and the skill
     writes every parameter immediately, per the steps below.
   - **I'll create them myself** — some teams manage secrets outside chat
     entirely (a vault, a security team, a separate change process) and
     don't want values typed here at all, even to an agent. If chosen: the
     skill never asks for or touches values. Instead, work out the exact
     variable **names** needed — check the target repo for `.env.example`/
     `.env.sample`/README env-var docs first, and add S3 credentials (Step
     6) and `DATABASE_URL` (Step 5b) to the list — then hand the user a
     plain list of the `/{app-name}/{environment}/{VAR_NAME}` names, plus the
     `put-parameter` command shape from `references/env-parameter-store.md`
     so they can run it themselves (or hand it to whoever manages secrets
     on their team). Skip straight to the "first deploy" gate below — do
     **not** proceed to Step 12 until the user explicitly confirms every
     listed parameter now exists (`aws ssm describe-parameters` to check
     names/existence only — never fetch or print values).

   Don't default to either path silently — this is the same principle as
   Step 3's confirmation gate: don't act on the user's secrets, even by
   asking for them in chat, without an explicit choice of mechanism.

   The rest of this step (1-5 below) applies to the **paste values now**
   path only.

1. Ask the user to paste the env content in chat. Append to it, if
   applicable: S3 credentials from Step 6
   (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/bucket name var(s)), and
   `DATABASE_URL` built from Step 5b's RDS secret or the external
   connection string given.
2. Write that content to a **local** temp file in the scratchpad (never
   the target repo) — transient, needed only to loop over it.
3. Loop over the file, writing each `KEY=VALUE` line as its own SecureString
   parameter — see `references/env-parameter-store.md` for the exact
   script (parsing that correctly preserves values containing `=`, e.g.
   connection strings, skips blank/comment lines) and why this runs from
   wherever the skill is executing, not on the box (setting parameters is
   the operator's action; fetching them is the box's, at deploy time).
4. Delete the local temp file immediately after.
5. **Never print a value** — the loop should echo only the key name for
   progress feedback (`Set DATABASE_URL`, `Set JWT_SECRET`, ...), never
   the value, and never echo the whole temp file's contents at any point.

RDS credentials don't need a separate parameter here beyond
`DATABASE_URL` above — the master credentials already live in Secrets
Manager permanently; storing them again would just be a stale duplicate.

There's no separate ".env placement" action anymore — the file only
materializes on the box the first time `app-pipeline-deploy.sh` actually
runs, which is Step 12's first real deploy trigger. Confirm the params
exist (`aws ssm describe-parameters`, metadata only, never reading values
back) before triggering that deploy.

Never let a `.env`/parameter value pass through any tool output, log, or
chat message after this point — not even a substring via grep (see
`references/gotchas.md`).

## Step 10 — Automated database backups (only if requested, EC2 path only)

Skip entirely for the static-site path (no server, nothing to back up on a
schedule) and if Step 2's answer was no. `references/db-backups.md` has the
full design writeup — this is the condensed sequence:

1. Deploy `templates/cfn/db-backup.yaml`:
   ```
   aws cloudformation deploy --region <region> \
     --stack-name <app-name>-db-backup \
     --template-file templates/cfn/db-backup.yaml \
     --tags Project=<project-tag-value> \
     --parameter-overrides AppName=<app-name> RetentionDays=<days, from Step 2>
   ```
   Read the `BucketArn`/`BucketName` outputs.
2. Redeploy `templates/cfn/ec2-instance.yaml` with
   `BackupBucketArn=<BucketArn from step 1>` added to its parameters — this
   grants the instance's existing role `s3:PutObject` on the new bucket
   only (write-only by design; see `references/db-backups.md`).
3. Render `templates/app/scripts/backup-db.sh.tmpl` and
   `templates/app/scripts/restore-db.sh.tmpl` (Step 8's `render.sh`
   mechanism — no placeholders in either file, so no `KEY=value` args
   needed) and push both to the instance the same way as the other hook
   scripts, e.g. `<app-dir>/scripts/`.
4. Run `backup-db.sh` once by hand over SSM before scheduling anything —
   confirm the zip lands in `s3://<bucket-name>/<app-name>/` and the
   lifecycle rule is attached. Then actually restore it into a scratch
   database (never straight into production) — `references/db-backups.md`
   has the exact commands. A backup that's never been restored is a hope,
   not a backup.
5. Install the cron job over SSM — check the existing crontab first and
   append, never overwrite:
   ```
   aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
     --parameters commands="['(sudo -u <os-user> crontab -l 2>/dev/null; echo \"<cron line>\") | sudo -u <os-user> crontab -']"
   ```
   `ENV_SOURCE_MODE=direct SSM_PARAM=/{app-name}/{environment}/DATABASE_URL` for any
   app built fresh by this skill (Step 9's one-param-per-var convention
   already puts `DATABASE_URL` there) — `references/db-backups.md` has the
   full cron-line shape and the frequency reasoning behind the default.

## Step 11 — DNS, nginx + TLS (only if a domain was given)

0. **Combined-host branch** (only if Step 2c's combined-host question was
   answered yes): no new DNS record or cert is needed — the sibling app
   already has both for this domain. Read the sibling's port and health
   path (its `ecosystem.config.js`/`after_install` render values, or ask
   the user directly if not readily at hand) and re-render
   `templates/app/nginx-combined.conf.tmpl` with **both** apps' ports and
   health paths, `___API_PREFIX___` (ask if not obviously `/api` — e.g.
   the backend's own global route prefix, if it has one), and
   `SERVER_NAMES` unchanged from the sibling's existing config. Push it
   via SSM to the **same** `/etc/nginx/sites-available/<domain>` file the
   sibling already uses (replacing its single-app config), `nginx -t &&
   systemctl reload nginx`, then skip straight to Step 12 — no new
   `dns-record.yaml` deploy, no new `certbot` call, both already cover
   this domain from the sibling's own Step 11 run.

1. **DNS record** (per Step 2c's answer). First: if Step 2 chose
   `AssignElasticIp=false` for this instance, flag the contradiction before
   proceeding — a domain pointing at the subnet's dynamic IP will silently
   break the next time the instance stops/starts. Confirm with the user
   whether to switch to a stable Elastic IP now (a stack update) or accept
   the risk knowingly.
   - Route53: deploy `templates/cfn/dns-record.yaml` with `TargetType=ip`,
     `TargetIp=<PublicIp output from Step 4>` — once for the primary
     domain, and **again** (same target, `RecordName=<secondary domain>`)
     if Step 2 gave a secondary domain. If no hosted zone existed yet,
     deploy `templates/cfn/hosted-zone.yaml` first (Step 3 gate applies —
     it's a new resource) and remind the user about the nameserver-update
     caveat in `references/dns-route53.md`.
   - External DNS: record this app's A-record requirement(s) (domain(s) →
     `PublicIp`, one row per domain if a secondary was given) for Step 14's
     records report (`references/dns-route53.md`) and wait for the user to
     confirm they're added and resolving before certbot, below — certbot's
     HTTP-01 challenge needs each domain actually pointing at the box first.
2. Render `templates/app/nginx.conf.tmpl` (reverse proxy on port 80 with
   per-IP rate limiting on the app port, health-check path exempted — see
   the template's own comments) with the domain, port, health path, app
   name, rate-limit values, and `SERVER_NAMES` = the primary domain alone,
   or `"<primary> <secondary>"` (space-separated) if a secondary domain
   was given. If Step 2's Basic Auth question was yes, generate the
   htpasswd file and fill `___RESTRICTED_LOCATION_BLOCK___` now — see
   `references/basic-auth-gating.md` for the exact commands; otherwise
   leave it as an empty string.
3. Push it via SSM to `/etc/nginx/sites-available/<domain>`, symlink into
   `sites-enabled/`, `nginx -t && systemctl reload nginx`.
4. `certbot --nginx -d <domain> [-d <secondary-domain>] --redirect --non-interactive --agree-tos -m <certbot renewal email from Step 2>`
   — one `-d` flag per domain, so the single cert covers both; certbot adds
   the HTTPS server block, cert paths, and HTTP->HTTPS redirect
   automatically for all of them — don't hand-write those into the
   rendered config.

## Step 12 — Verify end-to-end

- AWS CodePipeline: trigger with `aws codepipeline start-pipeline-execution`
  or have the user push to the deploy branch; poll
  `aws codepipeline get-pipeline-state` to completion.
- GitHub Actions: have the user push a commit (or push one yourself if you
  have repo write access) to the deploy branch; poll the workflow run via
  `gh run list`/`gh run watch`.
- Either way, finish by curling the health endpoint through the real
  domain (if set up) or `PublicIp` from Step 4, and report the live URL. If the
  deploy failed, check whether `/usr/local/bin/app-pipeline-rollback.sh`
  already self-healed the box back to the previous release (it does this
  automatically — see `references/release-rollback.md`) before assuming
  the app is down.
- If a staging environment was requested (Step 2), repeat Steps 4-12 for it
  per `references/staging-environment.md` — it's a second full pass, not an
  extension of the production one.
- If continuous uptime monitoring was requested (Step 2), deploy
  `templates/cfn/uptime-check.yaml` now — **after** the app is confirmed
  live above, never before (a check against an endpoint that isn't up yet
  just alarms for a reason that isn't real). See
  `references/uptime-monitoring.md` for the deploy command (**us-east-1
  explicitly**, same requirement as ACM) and target-type choice.

## Static-site path (frontend only — chosen in Step 2a)

Replaces Steps 4, 7, 8, 10, 11, and 12 entirely for this app (Step 10,
automated backups, doesn't apply either — no server, nothing to back up on
a schedule). Steps 3 (confirmation gate), 5a (notifications only — 5b
database doesn't apply to a static frontend), 13, and 14 still apply as
normal.

### SS1. ACM certificate (only if a custom domain was given)

Must be issued **before** SS2 if you want the ARN available for it (or
deploy SS2 once without a domain, then redeploy with it once the cert
issues — either order works). Deploy `templates/cfn/acm-certificate.yaml`
with `--region us-east-1` **explicitly**, regardless of the app's actual
region — hard CloudFront requirement:
```
aws cloudformation deploy --region us-east-1 \
  --stack-name <app-name>-cert \
  --template-file templates/cfn/acm-certificate.yaml \
  --parameter-overrides DomainName=<domain> \
    SecondaryDomainName=<secondary-domain-or-empty, per Step 2's answer> \
    HostedZoneId=<zone-id-or-empty>
```
If `HostedZoneId` was given (Route53, from Step 2c), this deploy
auto-validates both domains and blocks until issued. If DNS is external,
these validation record(s) are needed *first* (before SS3's app record) —
get them via
`aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[].ResourceRecord'`
(one per domain if a secondary was given) and add them to the records list
for Step 14's report; watch for `Status: ISSUED` before moving on — see
`references/dns-route53.md`.

### SS2. Site bucket + CloudFront

Deploy `templates/cfn/static-site-s3.yaml`:
```
aws cloudformation deploy --region <region> \
  --stack-name <app-name>-site \
  --template-file templates/cfn/static-site-s3.yaml \
  --tags Project=<project-tag-value> \
  --parameter-overrides AppName=<app-name> CustomDomain=<domain-or-empty> \
    SecondaryDomain=<secondary-domain-or-empty, same value as SS1's SecondaryDomainName> \
    AcmCertificateArn=<arn-or-empty, from SS1>
```
Read `BucketName`, `DistributionId`, `DistributionDomainName` outputs —
needed for SS3 and SS4.

### SS3. DNS record (per Step 2c's answer)

- Route53: deploy `templates/cfn/dns-record.yaml` with
  `TargetType=cloudfront`, `TargetCloudFrontDomain=<DistributionDomainName
  from SS2>` — once for the primary domain, and **again**
  (`RecordName=<secondary domain>`, same target) if a secondary domain was
  given. Must be an Alias record; CloudFront has no static IP.
- External DNS: add this app's record(s) to the Step 14 records list — one
  row per domain — CNAME (or ALIAS/ANAME, if the provider supports one for
  an apex domain — see the provider table in `references/dns-route53.md`)
  pointing at the CloudFront domain name.

### SS4. CI-mechanism-specific setup

Render `templates/app/buildspec.static.yml.tmpl` → `buildspec.yml` in the
target repo either way (CodePipeline reads it directly; for GitHub Actions
it's redundant with the workflow's own inline steps but still useful for
local reference — render it anyway for consistency).

- **AWS CodePipeline**: same CodeStar Connection reuse/creation logic as
  the EC2 path (`references/codestar-connection-setup.md`). Deploy
  `templates/cfn/static-site-pipeline.yaml`, passing `SiteBucketName`/
  `DistributionId` from SS2. `BuildTimeoutMinutes`/`DeployTimeoutMinutes`
  default to 20/15 — raise `BuildTimeoutMinutes` for a larger app.
  `CodeBuildImage`/`BuildComputeType` also default sensibly, same
  reasoning as the EC2 path's `pipeline.yaml`.
- **GitHub Actions**: same OIDC-provider check/create logic as the EC2 path
  (`references/github-oidc-setup.md`), but deploy
  `templates/cfn/github-oidc-role-static.yaml` instead of
  `github-oidc-role.yaml` — **do not reuse the EC2 path's role**, it's
  scoped to `ssm:SendCommand` and has no S3/CloudFront permissions at all;
  this is a deliberately separate, differently-scoped role. Render
  `templates/github-actions/deploy-static.yml.tmpl` → `.github/workflows/deploy.yml`.

**Build-time env vars have nowhere to live as a `.env` file — there's no
box.** Any `NEXT_PUBLIC_*` (or equivalent) value needed at build time goes
into `static-site-pipeline.yaml`'s `BuildProject.Environment.EnvironmentVariables`
(CodePipeline path) or GitHub Actions repo/environment secrets referenced
in `deploy-static.yml.tmpl`'s build step (GitHub Actions path) — never
written to a server, because there isn't one.

### SS5. Verify end-to-end

Trigger a deploy (push to the branch, or `start-pipeline-execution`), poll
to completion, then curl the CloudFront domain (or the custom domain, once
DNS has propagated) and confirm the homepage actually loads — not just that
the pipeline reported success.

If continuous uptime monitoring was requested (Step 2), deploy
`templates/cfn/uptime-check.yaml` now with `TargetType=domain` (CloudFront
has no stable IP, so `ip` doesn't apply here) — same `--region us-east-1`
requirement, see `references/uptime-monitoring.md`.

## Step 13 — Local dev env report

Generate `templates/app/local-dev-env-report.md.tmpl` (see
`references/local-dev-env.md` for exactly how to build each placeholder)
listing every `.env` variable a developer needs to run the app against the
same shared resources locally — S3 credentials from Step 6, and a database
connection that actually works from a laptop (which, for RDS, is **not**
just handing over the same `DATABASE_URL` used on the box — RDS isn't
publicly reachable; the reference doc covers the tunnel option).

Write it **outside the target repo** (e.g. the scratchpad/session
directory), not into the git working tree — a real-secrets file committed
by accident doesn't un-leak. Deliver it directly to the user (a file-send
tool if one's available, rather than pasting the whole thing into chat) and
tell them plainly: this file has real credentials in it, share it securely
and don't commit it anywhere.

Skip this step only if the app needs no S3/database credentials at all and
the `.env` placed in Step 9 has nothing else worth sharing for local dev.
For the static-site path, there's usually little to report here — no
server-side secrets exist for a purely static frontend — but still note
any build-time env vars (SS4) a developer needs set locally to build the
export themselves.

## Step 14 — Summary

Render `templates/app/pipeline-architecture-report.md.tmpl` and
`templates/app/pipeline-operations-report.md.tmpl` into the repo (e.g.
`docs/PIPELINE-ARCHITECTURE.md`/`docs/PIPELINE-OPERATIONS.md`) per
`references/pipeline-docs-generation.md` — do this by default, skip only if
the user explicitly says they don't want it. Unlike the local-dev-env
report, these have no secrets and belong in the repo, not off to the side.

List every AWS resource created (with stack names, so they're easy to find
later — EC2, RDS, S3, notifications, uptime check, pipeline/OIDC stacks,
and — for the static-site path — the site bucket, CloudFront distribution,
ACM cert, and DNS records, whichever apply), every parameter written to
`/{app-name}/{environment}/` in Parameter Store (names only, obviously —
see `references/env-parameter-store.md`), every file written into the repo
(including the two docs above), and the local dev env report's location.
Also call out, if applicable: an SSH deploy key was generated for a
private repo (`references/deploy-key-setup.md` — note it's per-app, not
reusable for a second app on the same instance), any path restricted
behind HTTP Basic Auth (`references/basic-auth-gating.md`), whether this
app shares a combined-host nginx config with a sibling app
(`templates/app/nginx-combined.conf.tmpl`) rather than its own domain, and
an app subdirectory if this is a monorepo setup — these are exactly the
kind of details someone picking this back up in 6 months won't remember
without a written record. Do **not** `git add`/commit/push on the user's
behalf — leave the generated files for them to review and commit
themselves, and remind them the local dev env report is *not* one of the
files meant for the repo (the architecture/operations docs are — that
distinction is worth stating explicitly since both are "generated
markdown files" at a glance).

**If DNS is external** (Step 2c), render
`templates/app/dns-records-report.md.tmpl` per
`references/dns-route53.md`'s "Reporting records for an external provider"
section and include its output directly in this response — not a link to
a reference doc, the actual table of records to add, right here, since
that's the one action item most likely to block the app from actually
being reachable once everything else is done.

Recap the actual monthly cost estimate from Step 3 here too, adjusted for
anything that changed during the run (a bigger instance type than first
discussed, an extra S3 bucket, etc.) — see `references/cost-estimates.md`.
