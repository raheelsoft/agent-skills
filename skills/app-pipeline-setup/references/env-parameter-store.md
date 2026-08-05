# Env vars in Parameter Store — the source of truth

Every env var lives in SSM Parameter Store as its own real, individually
named parameter — never a single opaque blob (an earlier version of this
skill used one `env-backup` parameter holding the whole file; that's
superseded — a name like `env-backup` describes nothing about what's
actually in it, and a blob can't be read/rotated/audited one variable at a
time the way individual parameters can).

## Naming convention

```
/{app-name}/{environment}/{VAR_NAME}
```
e.g. `/myapp/prod/DATABASE_URL`, `/myapp/prod/JWT_SECRET`,
`/myapp/prod/STRIPE_SECRET_KEY`. `{app-name}` matches `AppName` throughout
this skill's templates — `{VAR_NAME}` matches the env var name exactly, so
anyone reading the parameter list in the AWS Console immediately knows
what each one is, without needing to open `.env` at all. `{environment}` is
**not** hardcoded to `prod` anywhere — it's whatever value was written to
`<app-dir>/.environment` during Step 8's initial checkout (defaults to
`prod` when that file is absent, which is also what every app set up
before this convention existed effectively already has, so nothing
changes for a single-environment app).

**One fixed rule, not a judgment call**: `AppName` disambiguates the
*app* (and is what every stack name, IAM role name, and S3 bucket name is
built from — see `references/staging-environment.md` for why a second
environment for the same app still gets its own `AppName`, e.g.
`myapp-staging`); `{environment}` in the Parameter Store path is purely a
correctly-labeled lookup key, always matching what the environment is
actually called (`prod`, `staging`, `dev`). Never let the two drift — a
staging box's parameters living under a path segment literally spelled
`prod` (an easy mistake if `.environment` is forgotten at Step 8) is
confusing at best and a live example of exactly the "hardcoded environment
literal" failure mode in `references/gotchas.md` at worst. Staging
environments get their own Parameter Store tree entirely — never share
parameters between environments, regardless of naming.

## Two ways Step 9 can go

Step 9 asks the user up front which of these they want — never assume:

- **Paste values now**: the flow below runs as written, this skill writes
  every parameter itself.
- **User creates them later**: this skill never asks for or sees values —
  it only works out the variable *names* (check the repo for
  `.env.example`/`.env.sample`/README docs, plus S3/DB vars from Steps 5b/6)
  and hands the user the list below plus the exact command to run
  themselves. The skill must not proceed to Step 12's first deploy trigger
  until the user confirms every listed parameter exists.

## Writing parameters (Step 9 — from wherever the skill is running)

Setting parameters is the operator's action, not the box's — this runs
locally (or wherever this skill executes), reading a **local, temporary**
copy of the pasted `.env` content:

```bash
APP_NAME=myapp
ENV_FILE=/path/to/scratchpad/temp.env   # written once, deleted at the end

while IFS='=' read -r key value; do
  [ -z "$key" ] && continue
  case "$key" in \#*) continue ;; esac
  aws ssm put-parameter --region <region> \
    --name "/${APP_NAME}/prod/${key}" --type SecureString --overwrite \
    --value "$value" >/dev/null
  echo "Set ${key}"   # key name only — never the value, never the whole file
done < "$ENV_FILE"

rm -f "$ENV_FILE"
```

`IFS='=' read -r key value` correctly preserves embedded `=` characters in
the value (connection strings, base64-ish secrets, anything with a query
string) — `read` appends all remaining fields, delimiters included, to the
last named variable. Verified directly: `DATABASE_URL=postgresql://user:p@ss=word@host/db`
parses as `key=DATABASE_URL`, `value=postgresql://user:p@ss=word@host/db`,
not truncated at the first `=`.

## Reading parameters (every deploy — on the box)

`/usr/local/bin/app-pipeline-deploy.sh` (installed once per instance by
`templates/cfn/ec2-instance.yaml`) regenerates `.env` from Parameter Store
as part of every deploy, before `before_install.sh`/`after_install.sh` run:

```bash
APP_NAME="$(basename "$APP_DIR")"
APP_ENV="prod"
[ -f "$APP_DIR/.environment" ] && APP_ENV="$(cat "$APP_DIR/.environment")"
: > "$APP_DIR/.env"
aws ssm get-parameters-by-path --region "$AWS_REGION" --path "/$APP_NAME/$APP_ENV/" \
  --with-decryption --recursive --query 'Parameters[].[Name,Value]' --output text | \
  while IFS=$'\t' read -r param_name param_value; do
    printf '%s=%s\n' "${param_name##*/}" "$param_value" >> "$APP_DIR/.env"
  done
chmod 600 "$APP_DIR/.env"
```

`<app-dir>/.environment` is written once, at Step 8's initial checkout,
from the environment name given during the interview (e.g. `echo staging |
sudo -u <os-user> tee <app-dir>/.environment`). Absent entirely, this
falls back to `prod` — a deliberate default, not a silent guess: it's what
every existing single-environment setup already behaves as, so this
mechanism only ever changes behavior for an app that explicitly opts into
naming its environment something else.

- The AWS CLI auto-paginates `get-parameters-by-path` by default — this
  returns every parameter under the path regardless of count, not just the
  first page (a real app easily has 15-20+ vars, well past a single page).
- Piped straight into a `while read` loop that only writes to the file via
  redirection — never printed to stdout, which SSM/CodeBuild persist
  indefinitely (see `references/gotchas.md`'s secret-echo warning).
- Requires `ssm:GetParameter` (to read) on the instance's own role, scoped
  to `/${AppName}/*` — already granted by `ec2-instance.yaml`'s
  `app-parameter-store-access` policy. That policy also grants
  `ssm:PutParameter` on the same scope, kept for any on-box use (e.g. a
  script rotating its own value), though the primary write path (Step 9)
  runs from the operator's side, not the box's.

## What this means operationally

- **Changing a var**: update the parameter (`put-parameter --overwrite`),
  then trigger a deploy (push, or `start-pipeline-execution`) — the box
  picks it up automatically the next time `app-pipeline-deploy.sh` runs.
  There's no file to SSH/SSM in and edit anymore.
- **First deploy**: parameters must exist *before* Step 12's first
  trigger — `get-parameters-by-path` against an empty/nonexistent path
  just produces an empty `.env`, not an error, so a forgotten var fails
  silently as a missing env var at app startup, not a deploy-time error.
  Confirm the expected parameters exist (`aws ssm describe-parameters`,
  metadata only) before the first real trigger.
- **Rollback** (`references/release-rollback.md`) doesn't touch Parameter
  Store at all — `app-pipeline-rollback.sh` just relinks `current` to the
  previous release and restarts; the regenerated `.env` from the most
  recent successful `app-pipeline-deploy.sh` run stays as-is.
- **Local dev** (`references/local-dev-env.md`): the local-dev-env report
  is still built the same way conceptually — it's just that its source is
  now individually-named parameters instead of a single file, which if
  anything makes it easier to hand over exactly the subset a developer
  actually needs rather than the whole `.env`.
