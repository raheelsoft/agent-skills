# Gotchas — read before debugging a failure, not after

Every one of these was hit for real building the first instance of this
pipeline by hand. Check this list before assuming something new is broken.

## CodeBuild silently runs the wrong Node version
`aws/codebuild/standard:7.0`'s bundled Node (via nvm, an old version) sits
**ahead of `/usr/bin` on PATH by default**, even inside the same shell phase
that just `apt-get install`ed the real one. `export PATH="/usr/bin:$PATH"`
must be re-asserted at the start of **every** buildspec phase (install,
pre_build, build) — CodeBuild does not guarantee exported vars persist
across phase boundaries. If a build fails with a Node-version-looking error,
check `node -v` near the top of the log first.

## Bootstrapping the server via CloudFormation UserData doesn't survive a resize or a second app
Installing nvm/Node/pm2/nginx/Postgres directly in `ec2-instance.yaml`'s
UserData looks like the obvious approach, and it's what this skill did at
first — but UserData is a **one-shot script**: it runs once at instance
creation and CloudFormation has no way to re-invoke it. That surfaced as
two separate real failures, not a hypothetical:

1. An instance too small for the Node build it needed to run had no safe
   path forward — resize the instance and the bootstrap that already
   half-ran (or OOM-killed partway through) never runs again. There was no
   "just try again on a bigger box."
2. Targeting an existing instance for a second app that needed Postgres,
   when the box was never provisioned with it, silently didn't get it —
   nothing re-ran, and the gap wasn't obvious until the second app failed
   to start.

Fixed by moving all of it out of UserData entirely, into
`templates/app/scripts/server-bootstrap.sh.tmpl`, rendered and run over
SSM RunCommand (Step 4b) instead — every step written idempotent
specifically so it's safe to retry after a resize or re-run against a live
instance. `ec2-instance.yaml` itself now provisions bare compute only
(instance, security group, IAM role, alarms, Elastic IP) — no
`CreationPolicy`, no `cfn-signal`, nothing installed as part of resource
creation. Full mechanism, the resize-and-retry rule, and the subagent
report contract that decides whether a resize is even warranted are in
`references/server-bootstrap.md`.

## Small instances OOM on a Node build
t3.micro-class instances (~900MB RAM) hit `FATAL ERROR: Reached heap limit`
building anything non-trivial. Fixed by: a swap file (provisioned by
`server-bootstrap.sh.tmpl`, see above) plus
`NODE_OPTIONS=--max-old-space-size=...` in `after_install.backend.sh.tmpl`.
If this comes back, check the swap file is still mounted (`swapon --show`)
and the instance type wasn't downsized. The same signal (`dmesg | grep -i
"killed process"` for the OOM killer, or `free -m` showing swap exhausted)
is what Step 4b's bootstrap-failure report uses to decide whether a
resize-and-retry question is actually warranted — see
`references/server-bootstrap.md`'s subagent report contract.

## Why SSM-triggered deploy instead of real CodeDeploy
Both `appspec.yml` and the four hook scripts are written in exactly the
shape CodeDeploy expects — but the CodeDeploy **agent** fails to install on
recent Ubuntu LTS (its legacy installer's version-check regex rejects
Ruby 3.x, which current Ubuntu ships by default). Rather than fight that,
the CI trigger (CodePipeline's Deploy-stage CodeBuild project, or the GitHub
Actions workflow) drives the same hooks directly over SSM RunCommand, in the
same order CodeDeploy would use. If an older Ruby ever gets installed
specifically for this, or the agent's installer gets fixed upstream, these
appspec/hook files can go straight to a real CodeDeploy deployment group
with zero changes.

## `validate_service.sh` needs to poll, not sleep-once
A real, successful deploy can still report Failed if this script does a
single fixed sleep — right after a build, the box can still be under memory
pressure when pm2 reports "online" but the app hasn't actually bound its
port yet. The template polls for up to 60s (12 × 5s) instead of one
fixed-delay attempt. If a deploy is reported Failed but the app looks fine
when checked directly, this is almost always why.

## Frontend build-time env vars
Next.js's `NEXT_PUBLIC_*` vars (and equivalents in other frameworks) are
baked into the client bundle at **build** time, not read at runtime. Editing
`.env` on the box and reloading pm2 does nothing for these — a full rebuild
(`after_install.frontend.sh.tmpl`, i.e. a real deploy) is required.

## Lockfile presence varies by repo
Some repos deliberately `.gitignore` their lockfile (team convention, not an
oversight) — `npm ci` then fails outright since it requires one. The skill
checks for `package-lock.json` before choosing `npm ci` vs `npm install`;
don't "fix" a missing-lockfile failure by switching back to `npm ci` without
first confirming a lockfile is actually meant to be tracked.

## Never grep/echo anything that could substring-match a secret
A pattern like `grep BASE_URL .env` will also match `DATABASE_URL` (or any
var containing that substring) and print it. When reading/updating a single
`.env` var via SSM or in a script, anchor the pattern (`^VAR_NAME=`) and
never `cat`/echo the whole file into a log any CI system captures — CodeBuild
and CodeDeploy/SSM both persist stdout indefinitely.

## Root disk fills up under repeated builds
The default 8GB Ubuntu root volume fills up fast from repeated
`npm ci`/build churn. `templates/cfn/ec2-instance.yaml` defaults to 20GB —
if builds start failing with no clear error, `df -h /` first.

## GitHub OIDC `sub` claim changes for renamed repos/owners
See `references/github-oidc-setup.md`.

## Two different engagements picking the same AppName silently collide
Every stack name, IAM role name, and S3 bucket name this skill creates is
built from `AppName` alone, account-and-region-wide, not scoped to
"whichever client/repo this run is for." A short, generic `AppName` (e.g.
`api`, `backend`, `app`) is exactly the kind of value two unrelated
engagements in the same AWS account independently pick — the second run
either fails outright (an IAM role name that already exists, from a
different app entirely) or, worse, silently updates the *first* engagement's
stack if the stack name also matches, since `aws cloudformation deploy`
against an existing stack name is an update, not a creation error. Step
2b's app-identity question exists specifically to head this off — push
back on a generic single-word `AppName` and suggest a client/project
prefix (`acme-api`, not `api`) — and Step 3's confirmation gate should
include an `aws cloudformation describe-stacks --stack-name
<app-name>-instance` (and the other stack names about to be created)
check: an unexpected **existing** stack under a name this run didn't
expect to already own is a stop-and-ask moment, not something to `deploy`
straight over.

## Reusing an existing instance for a second app can pick up a new capability
A second app needing Postgres, when the box was never provisioned with it
(the failure mode `server-bootstrap.sh.tmpl`'s idempotency was built to
fix — see the bootstrap entry above): re-running the script against a live
instance with `NeedsPostgres=true` (or a different `NodeMajorVersion`,
etc.) safely adds the missing piece without disturbing what's already
there. nginx itself already handled multiple domains/apps on one box fine
(each gets its own `sites-available/<domain>` file, no collision) — this
was the one remaining gap, and it's closed. Still worth being deliberate
about it though: re-running the script is a real change to a live,
in-use instance (an `apt-get install` and a `systemctl restart postgresql`
on a box another app is already running on) — treat it the same as any
other infra-affecting action, not something to do silently just because
it's now technically safe to.

## Real waits vs hand-rolled polling loops — pick deliberately, don't default to either
Two different situations, two different right answers:
- **CloudFormation resource creation** (`ec2-instance.yaml`'s `Instance`,
  and every other stack this skill deploys): `aws cloudformation deploy`
  blocks natively until the stack settles — no separate poll loop needed
  for the AWS-resource-creation part itself. This template deliberately
  has no `CreationPolicy`/`cfn-signal` (removed along with UserData, see
  `references/server-bootstrap.md`) — there's no longer anything on the
  box for CloudFormation to wait on, since bootstrap isn't part of
  instance creation anymore.
- **SSM registration** (Step 4, after the CFN deploy returns) and **SSM
  command completion** (Step 4b's bootstrap, and every app deploy via
  `pipeline.yaml`/`deploy.yml.tmpl`): hand-rolled loops, deliberately —
  `aws ssm wait command-executed` exists but its delay/max-attempts budget
  is fixed and far shorter than a real bootstrap or build+deploy can
  legitimately take, with no CLI flag to override it. The deploy loop is
  keyed off `DeployTimeoutMinutes` for exactly that reason, not an
  oversight that should get "fixed" by swapping in the built-in waiter.

The lesson isn't "always prefer AWS's native wait mechanism" or "always
hand-roll polling" — it's checking whether the native mechanism's actual
behavior (timeout budget, configurability) fits the real wait time needed,
case by case. Notably, this used to split one way (CFN native wait for
bootstrap, hand-rolled for deploy) and now doesn't — both bootstrap and
deploy hand-roll their polling, for the same reason: neither one fits
inside a fixed, non-configurable timeout budget.

## Test a hook-script change through the exact real execution wrapper, not an approximation
`app-pipeline-deploy.sh` and everything it calls (`before_install.sh`
through `validate_service.sh`) run as `${OsUser}` end to end, via the
outer `sudo -u ${OsUser} bash -lc '...'` in `pipeline.yaml`/
`deploy.yml.tmpl` — never as root, regardless of what a `runas` field in
some unrelated appspec-style convention might imply. A live, real-world
version of this exact mistake: assuming a hook ran as root because that's
the CodeDeploy convention, testing a permission-sensitive change by
running it directly via a bare SSM command (which defaults to root) and
seeing it pass, then watching it fail in production because the actual
invocation is nested one level deeper inside `sudo -u <user>`. Both of
this skill's own generated hook scripts already get this right (`chown -R
${OsUser}:${OsUser}` covers the whole `apps/` parent in `ec2-instance.yaml`,
not just individual app subdirectories, so `${OsUser}` can create files
*and* subdirectories anywhere under it) — but if you're ever modifying
`app-pipeline-deploy.sh`, the hook scripts, or anything else in this
chain, verify a permission-sensitive change by invoking it through the
**exact** nested wrapper (`sudo -u ${OsUser} bash -lc '...'`), not a bare
root-context command — the two can give different, misleading results for
the identical script.

## A relocatable hook script can still hardcode the environment name
Fixing the directory-path hardcode (above pattern: no hardcoded `cd`) is
not the same as making a script safe to reuse across environments. A real
example hit in production: `after_install.sh` had no hardcoded `cd`
(already fixed for atomic-release compatibility) but still read
`aws ssm get-parameters-by-path --path /discovery-town-be/prod/` with
`prod` written as a literal. Reusing that script as-is for a staging/dev
box (Step 8's "Reuse as-is" option) would silently fetch **prod's**
parameters onto the new box instead of the new environment's own — wrong
config at best, a prod-secret leak at worst — and the script still runs
to completion without erroring, so nothing about the deploy's own output
flags it. The fix: the invoking script exports `APP_ENV` once (default
`prod`, so existing behavior is unchanged for every environment that
doesn't set it), and the hook reads `/{app-name}/${APP_ENV}/` instead of
a literal. When evaluating Step 8's reuse/adapt/render decision, grep
existing hook scripts for the environment name as a literal (not just a
directory `cd`) — the two checks are independent and a script can pass
one while failing the other.

## Prisma's `?schema=public` breaks `pg_dump`/`psql` (Step 10, `references/db-backups.md`)
Prisma's `DATABASE_URL` convention appends a query string (commonly
`?schema=public`) that libpq doesn't recognize as a valid connection URI
parameter — `pg_dump --dbname="$url"` fails outright with
`invalid URI query parameter: "schema"`, even though the exact same URL
works fine for the app itself (Prisma parses it, doesn't hand it to libpq
raw). `backup-db.sh.tmpl` already strips everything from the first `?`
onward before connecting — safe, since `pg_dump` backs up every schema in
the database regardless of what that query param says. If any other
libpq-based tool (not just this skill's backup script) is ever pointed
directly at a Prisma app's `DATABASE_URL`, expect the same failure and the
same fix.

## Some AMIs run SSM's `AWS-RunShellScript` via `sh` (dash), not bash
Hit while building/debugging the backup feature: even on a box where bash
is installed and is the login shell, `AWS-RunShellScript` commands can
execute via `/bin/sh` (dash on Ubuntu), not bash — bash-only syntax
(`${var:0:1}`/`${var: -1}` slicing, arrays) fails with "Bad substitution"
there, silently different from how the same snippet behaves when typed
into an actual SSH/SSM-session shell. Give any ad hoc remote diagnostic
script (not the checked-in `.tmpl` files, which are already POSIX-safe
where it matters) an explicit `#!/bin/bash` shebang and execute it as a
file, or just write it POSIX-sh-safe to begin with — don't assume the
document's default interpreter matches the box's interactive shell.

## A forced app reload can surface an unrelated, pre-existing bug — not just test the change you made
Any operation that requires a full app restart/reload to take effect (a
credential rotation is the common case, since the new value has to
actually get picked up) re-reads **every** current env var against
**every** current line of deployed code — not just the one thing you
changed. Real incident: rotating a DB password required a `pm2 reload` to
pick it up; the reload immediately crash-looped the app on an unrelated,
already-latent bug — a recent code change required a renamed env var
(`AWS_BUCKET_NAME`) that had never actually been added to Parameter Store,
invisible until the next full reload happened to touch that code path.
Nothing about the rotation itself was wrong; the reload it required was
just the first thing to actually exercise the gap. Lesson: before forcing
a reload for an unrelated reason, it's worth a quick check that the app's
required env vars haven't drifted from what's actually stored (recent
commits touching `ConfigService`/`configService.get(...)`/`process.env`
calls) — and afterward, confirm health via **both** the process staying up
(pm2 restart count holding steady, not climbing) and a real endpoint
response, not just "the command that triggered the reload exited zero."

## A large payload embedded directly in an SSM `send-command` call hits a 97KB limit
`aws ssm send-command`'s total parameter+document size is capped at 97KB.
Base64-embedding anything non-trivial (a SQL dump, a large file) directly
into a `commands` array element fails with `MaxDocumentSizeExceeded` well
before that feels like it should be a constraint. Upload the file to S3
first and have the remote script download it instead — or, if the
instance's own IAM can't read that bucket (e.g. `db-backup.yaml`'s bucket
is deliberately write-only from the instance's own role — see
`references/db-backups.md`), generate a short-lived presigned URL from
wherever broader S3 access does exist and `curl` that on the box instead of
widening the instance's IAM policy just for a one-off transfer.

## Never construct a command in a way that lets an error message echo a secret back
Real near-miss: a connectivity-test command built by embedding a fetched
`DATABASE_URL` into a manually-quoted `--parameters 'commands=[...]'`
string had a quoting bug — the malformed value it produced caused the
connection tool's own error message to print a large chunk of the real
credential (user/password/host) back into the command output, which then
sat in both the chat transcript and AWS's own SSM command-invocation
history (retained server-side, same as any other command output — see the
"never grep/echo anything that could substring-match a secret" gotcha
above). The bug was in the *test tooling*, not the credential itself — but
the moment a value like that appears anywhere, even once, even seemingly
by accident, treat it as compromised and rotate it immediately. Prefer
`--cli-input-json` built via `jq` over hand-rolled `--parameters
'commands=[...]'` string quoting for anything nontrivial — manual JSON
string construction is exactly the kind of thing that goes wrong in ways
that are hard to predict and, as here, can leak through an error-message
path you didn't anticipate rather than a straightforward syntax failure.
