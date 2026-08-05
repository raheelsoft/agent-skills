# Staging/dev environment

If the user wants a second environment alongside production, it is not a
different template — every CFN template in this skill is already
parameterized per-app, so a staging environment is the same procedure
(Steps 4-11 in SKILL.md) run a second time with different parameter values
and stack names. Nothing new to build; this doc is about what to vary.

## What to change for staging

- **AppName**: give staging its own `AppName` value, always suffixed
  (never the bare production name with nothing to distinguish it) — e.g.
  `AppName=myapp-staging` alongside production's `AppName=myapp`. This is
  the one fixed rule, not a per-run judgment call: every stack name, IAM
  role name, and S3 bucket name in this skill's templates is built from
  `AppName` alone (`${AppName}-instance`, `${AppName}-instance-role`,
  `${AppName}-pipeline-artifacts-${AWS::AccountId}`, ...), and IAM role
  names in particular are unique per-account-per-region, not
  per-CloudFormation-stack — reusing the bare `AppName` for both prod and
  staging would collide creating staging's `InstanceRole`, not just read
  confusingly. This gives `<app-name>-staging-pipeline`,
  `<app-name>-staging-instance`, etc. automatically, with no separate
  "suffix the stack name" step to remember.
- **Environment**: separately, give staging its own environment label
  (`staging`) via the `.environment` file written during Step 8 (see
  `references/env-parameter-store.md`) — this controls only the Parameter
  Store path (`/{app-name}/{environment}/{VAR}`), so staging's secrets are
  correctly labeled `/myapp-staging/staging/...` rather than the
  misleading `/myapp-staging/prod/...` a forgotten `.environment` file
  would silently produce. `AppName` already provides full resource
  isolation on its own (previous bullet) — this second setting is purely
  about correct labeling, not isolation, so don't skip it thinking
  `AppName`'s suffix already covers it.
- **Branch trigger**: staging's `pipeline.yaml`/GitHub Actions workflow
  should trigger off a non-`main` branch — typically `dev` or `staging`.
  Production keeps triggering off `main`. These are two separate
  pipeline/workflow instances, each watching one branch.
- **Instance type**: default to something smaller than production for
  staging (e.g. `t3.micro` even if production is bigger) unless the user
  specifically wants staging to mirror production's load characteristics.
- **RDS, if used**: `MultiAZ=false` and a shorter `BackupRetentionPeriod`
  (e.g. 1-3 days, or even the RDS minimum) for staging — there's usually no
  need to pay for production-grade durability on disposable data. Consider
  `DeletionProtection=false` for staging too, so the whole environment can
  be torn down cleanly when not needed.
- **Domain**: a subdomain convention like `staging.app.example.com` if TLS
  is set up for staging at all — plenty of teams skip TLS/nginx entirely
  for staging and just hit `PublicIp` directly on the app's raw port. If
  no domain is going to point at it, `AssignElasticIp=false` is a
  reasonable default for staging specifically — the dynamic-IP tradeoff
  doesn't matter without DNS depending on it, and it's one fewer resource
  to account for on a disposable environment.
- **Notifications**: either point staging's `NotificationTopicArn` at a
  separate, less noisy topic/subscription, or skip notifications for
  staging entirely — a failed staging deploy is lower urgency than
  production.

## What stays the same

- The app-side rendered files (`buildspec.yml`, `appspec.yml`,
  `ecosystem.config.js`, the deploy hook scripts) don't need a staging
  variant — they're already generic. Only the CFN parameter values passed
  at deploy time differ between environments. **This assumes prod itself
  was set up by this skill** — see the next section if it wasn't.
- The release/rollback mechanics (`references/release-rollback.md`) are
  identical — each environment just gets its own `<app-dir>` on its own
  instance (or the same instance, if intentionally co-locating, though a
  separate instance is the more common and more isolated choice).

## Existing infra this skill didn't build

Adding staging to an app whose production deploy predates this skill (a
hand-built pipeline, or one from a different tool) is still just Steps
4-11 run again — the infra side is unconditionally generic, regardless of
how prod was built. What needs actual judgment is the app-side hook
scripts (Step 2a-pre / Step 8 in SKILL.md):

- Prod's existing `scripts/before_install.sh` etc. almost certainly do the
  right build/run steps already (npm install, build, migrate, seed, pm2
  reload) — reusing them for staging, rather than re-deriving equivalent
  logic from scratch into this skill's generic templates, is usually the
  better default *if* they're safe to run that way.
- The concrete thing to check — two independent incompatibilities, either
  can be present alone:
  1. Do they hardcode an absolute app path (e.g.
     `cd /home/<user>/apps/<app-name>` at the top) instead of operating on
     whatever directory they're invoked from? This skill's
     `app-pipeline-deploy.sh` runs each hook from inside a per-deploy
     `releases/<sha>/` directory, not a single fixed path — a hardcoded
     `cd` would make the hook silently build in the wrong place and
     defeat atomic releases/rollback for that environment. A real example
     of this exact shape: a hand-built `after_install.sh` that starts
     with `cd /home/ubuntu/apps/<app-name>` unconditionally.
  2. Do they hardcode the **environment name** anywhere, most commonly a
     Parameter Store path like `/{app-name}/prod/` written as a literal?
     Reused as-is for staging, this pulls **prod's** parameters onto the
     staging box instead of staging's own — silently wrong config, or a
     prod-secret leak onto a lower environment, and the script still runs
     without erroring so it's easy to miss. A real example: a hand-built
     `after_install.sh` with
     `aws ssm get-parameters-by-path --path /discovery-town-be/prod/`
     baked in — fixed by having the invoking script (`deploy.sh` or
     equivalent) `export APP_ENV="${APP_ENV:-prod}"` once, and the hook
     read `/{app-name}/${APP_ENV}/` instead; the default preserves prod's
     existing behavior exactly, and a staging box just needs `APP_ENV` set
     to `staging` at invocation time.
- If either is found, either strip/parameterize it (the script's
  remaining logic usually needs no other change — `app-pipeline-deploy.sh`
  already `cd`s into the release directory before invoking it, and
  `APP_ENV` covers the environment-literal case) or render this skill's
  own generic templates instead and re-fill Step 8's placeholders to
  match prod's actual build steps. Don't silently pick either.
- Prod's own deploy mechanism (CodeDeploy, a custom `deploy.sh`, whatever
  it is) doesn't need to match staging's. Staging deploys via this
  skill's `app-pipeline-deploy.sh` + SSM RunCommand regardless — only the
  hook scripts' *content* is worth reusing, not whatever orchestrated
  them in prod.

## Confirmation gate still applies per environment

Provisioning a staging environment is a second, separate set of AWS
resources — Step 3's confirmation gate applies again for it, not just once
for "the pipeline" as a whole.
