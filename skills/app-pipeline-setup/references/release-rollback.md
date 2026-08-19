# Release/rollback model

Every deploy (CodePipeline or GitHub Actions) ultimately runs
`/usr/local/bin/app-pipeline-deploy.sh <app-dir> <branch>` on the instance
over SSM. That script is installed once per instance (by
`templates/app/scripts/server-bootstrap.sh.tmpl`, itself run over SSM —
see `references/server-bootstrap.md`), not per app — every app hosted on
the box shares the same copy.

## Directory layout, per app

```
<app-dir>/
├── repo/           # persistent git checkout, always reset to the deploy branch
├── releases/
│   ├── a1b2c3d/    # rsync copy of repo/ at that commit, fully built
│   └── e4f5a6b/
├── current -> releases/e4f5a6b/   # symlink — this is what pm2 actually runs
└── .env            # lives outside releases/, symlinked into each one
```

## What a deploy actually does

1. `repo/` is fetched and hard-reset to the target branch.
2. The resulting commit is rsync'd into a new `releases/<short-sha>/`
   directory (source excluded).
3. `<app-dir>/.env` is regenerated from scratch by fetching every
   parameter under `/{app-name}/prod/` in SSM Parameter Store (the actual
   source of truth — see `references/env-parameter-store.md`), then
   symlinked into the new release directory. Every deploy picks up
   whatever's currently in Parameter Store, not whatever was last written
   to the file.
4. `before_install.sh` then `after_install.sh` run **inside the new release
   directory** — this is where `npm ci`/`install`, the build, and (backend)
   `prisma migrate deploy` + seeding happen. The previous release is
   untouched and still serving traffic through this whole step.
5. Only once the build succeeds does `current` get relinked to the new
   release.
6. `application_start.sh` (`pm2 startOrReload`) and `validate_service.sh`
   run from `current`.
7. If `validate_service.sh` fails, `app-pipeline-deploy.sh` calls
   `/usr/local/bin/app-pipeline-rollback.sh <app-dir>` automatically, which
   relinks `current` back to the previous release and restarts pm2 against
   it — no rebuild needed, near-instant. The pipeline/workflow still reports
   the deploy as failed (so the failure is visible and, if
   `templates/cfn/notifications.yaml` is wired in, notified) even though the
   box has already self-healed back to the last-good release.
8. On success, releases older than the 5 most recent are pruned (the
   release `current` points to is never pruned, even if it's not among the
   5 most recent by mtime — e.g. right after a manual rollback).

## Two overlapping deploys

Two triggers for the same app (a manual `start-pipeline-execution` racing
a delayed GitHub webhook is a real, observed failure mode, not a
theoretical one) are guarded at two layers:

- **Pipeline level** (`templates/cfn/pipeline.yaml` /
  `static-site-pipeline.yaml`): `PipelineType: V2` +
  `ExecutionMode: QUEUED` makes a second execution wait for the first to
  finish rather than running its Deploy stage concurrently. This is the
  primary protection — it stops the race before it ever reaches the box.
- **Box level** (`app-pipeline-deploy.sh`): a per-app `flock` (up to 20
  minutes) around the whole fetch/build/relink sequence, as a backstop for
  anything the pipeline-level queue doesn't cover — a manual SSM
  RunCommand invocation outside the pipeline, for instance. Without this,
  two concurrent in-place operations on the same `repo/` checkout or
  `current` symlink can corrupt a running process (a real incident: two
  overlapping deploys once raced an in-place `next build` + `pm2 reload`
  outside this skill's atomic release-directory model, corrupting a live
  worker process — the atomic `releases/<sha>/` + `current` symlink swap
  used here, plus this flock, is specifically what prevents that class of
  bug).

If `DeployTimeoutMinutes` is raised for a heavy app, remember the flock
wait (up to 20 min) is on top of the actual build+deploy time when sizing
it — see the parameter's description in `pipeline.yaml`.

## Manual rollback

To roll back outside of a failed deploy (e.g. a release passed validation
but has a bug found later):
```
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters commands="['sudo -u <os-user> /usr/local/bin/app-pipeline-rollback.sh <app-dir>']"
```
This only goes back one release (the second-newest in `releases/`). To go
back further, either roll back repeatedly or manually relink `current` to a
specific `releases/<sha>/` directory over SSM.

## Why `.env` lives outside `releases/`, and where it actually comes from

Each release directory is disposable and gets pruned — `.env` must survive
across all of them, so it's regenerated once at `<app-dir>/.env` per
deploy and symlinked into every release rather than copied per-release.
It is **not** hand-edited on the box at all anymore — the real source of
truth is SSM Parameter Store (`references/env-parameter-store.md`, Step 9
in SKILL.md). Updating a parameter affects the box only once a deploy
actually runs and regenerates the file; it does **not** affect the
currently-running release until then (same build-time-vs-runtime caveat as
`NEXT_PUBLIC_*` vars — see `references/gotchas.md`).
