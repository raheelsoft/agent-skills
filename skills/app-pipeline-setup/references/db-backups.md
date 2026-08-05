# Automated database backups

Scheduled `pg_dump` → zip → upload to a private, encrypted S3 bucket, with
automatic cleanup via a lifecycle rule and a proven restore path. Relevant
to **local Postgres on the app box** (`NeedsPostgres=true` in
`ec2-instance.yaml`) and **external/already-have-one** databases the app
connects to over the network — RDS already has its own automated backups
(`BackupRetentionPeriod`) and doesn't need this on top, see
`references/rds-database.md`.

Built and proven end-to-end (real dump → real S3 upload → real restore into
a scratch database, real row counts verified) across two production
Node.js/Postgres projects — this isn't a theoretical design.

## What gets created

- `templates/cfn/db-backup.yaml` — one private, SSE-S3-encrypted S3 bucket
  with a lifecycle rule expiring objects after `RetentionDays`. Nothing else
  in this stack.
- `templates/cfn/ec2-instance.yaml`'s `BackupBucketArn` parameter, set to
  that bucket's ARN — adds one conditional inline IAM policy
  (`db-backup-s3-put`) to the instance's own role, granting `s3:PutObject`
  on that bucket **only**. No read/list/delete access — a compromised
  instance can write new backups but can't exfiltrate or wipe existing
  ones. (Verified in practice: `aws s3 cp` *from* the instance correctly
  403s under this policy — pull a backup back down from a machine with
  broader S3 access instead, or generate a presigned URL from one, per
  "Restoring a backup" below.)
- `templates/app/scripts/backup-db.sh.tmpl` / `restore-db.sh.tmpl`, rendered
  onto the instance in Step 8 alongside the other hook scripts.
- A cron job on the instance (installed in Step 10), running `backup-db.sh`
  on a schedule.

## Setup flow

1. Deploy `templates/cfn/db-backup.yaml`:
   ```bash
   aws cloudformation deploy --region <region> \
     --stack-name <app-name>-db-backup \
     --template-file templates/cfn/db-backup.yaml \
     --tags Project=<project-tag-value> \
     --parameter-overrides AppName=<app-name> RetentionDays=<days>
   ```
   Read the `BucketArn`/`BucketName` outputs.
2. Pass `BucketArn` into `ec2-instance.yaml`'s `BackupBucketArn` parameter —
   redeploy that stack if the instance already exists (same pattern as
   `NotificationTopicArn`).
3. Render `backup-db.sh.tmpl`/`restore-db.sh.tmpl` (Step 8) and push them to
   the instance the same way as the other hook scripts.
4. Install the cron job (Step 10) — see "Recommended frequency" below for
   the exact line.
5. Run it once by hand before trusting cron with it (see "Verify before
   scheduling" below).

## `ENV_SOURCE_MODE` — how `backup-db.sh` finds `DATABASE_URL`

For an app this skill builds fresh, this is always **`direct`** mode
against `/{app-name}/prod/DATABASE_URL` — Step 9 already stores env vars
one-parameter-per-variable, so `DATABASE_URL` already exists as its own
parameter by the time this step runs. The other three modes exist for
**Step 2a-pre's "add to existing infra" flow**, where the app's pre-existing
env-var storage might not follow this skill's own convention:

| Mode          | What `SSM_PARAM` points at                                       | When it applies |
|---------------|--------------------------------------------------------------------|--------------------|
| `direct`      | One SSM parameter holding `DATABASE_URL`'s value directly          | This skill's own Step 9 convention — the default for a fresh build |
| `blob`        | One SSM parameter whose Value is a whole `.env` file's text        | An existing app stores its entire `.env` as one parameter |
| `path-chunks` | An SSM path prefix; parameters under it are concatenated in Name order | An existing app's `.env` was too big for one parameter (Standard tier's 4096-char cap) and got split |
| `local-file`  | A local file path on the instance                                  | An existing app doesn't use SSM Parameter Store at all |

Check the app's actual `after_install.sh` (or equivalent) before assuming —
same caution as Step 8's hook-script reuse/adapt decision.

**Prisma users**: `DATABASE_URL` conventionally ends in `?schema=public` (or
similar) — `pg_dump`/libpq don't understand that query parameter and fail
with `invalid URI query parameter: "schema"`. `backup-db.sh.tmpl` already
strips everything from the first `?` onward before connecting; `pg_dump`
backs up every schema regardless of what that query param says, so this is
safe. No action needed, just know it's there.

## Recommended frequency

Ask the user explicitly (see Step 2b's new interview question) rather than
defaulting silently — but the sane default, absent a stronger reason, is
**twice daily**:

```
0 0,12 * * * APP_NAME=<app-name> ENV_SOURCE_MODE=direct SSM_PARAM=/<app-name>/prod/DATABASE_URL BACKUP_BUCKET=<bucket-name> AWS_REGION=<region> /home/<os-user>/apps/<app-name>/current/scripts/backup-db.sh >> /var/log/db-backup-<app-name>.log 2>&1
```

A 12-hour worst-case data-loss window balances RPO against storage/CPU
cost for most apps. Alternatives:
- **3x/day** (`0 0,8,16 * * *`) — tighter 8h window, ~3x the cost. Worth it
  for heavy write volume or when an 8h RPO genuinely matters more than the
  extra cost.
- **Once daily** (`0 0 * * *`) — simplest, cheapest, 24h window. Fine for
  low-traffic/internal apps.

Install via SSM (same mechanism as any other on-box change this skill
makes):
```bash
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters commands="['(sudo -u <os-user> crontab -l 2>/dev/null; echo \"<cron line>\") | sudo -u <os-user> crontab -']"
```
Check the existing crontab first and append rather than overwrite — same
idempotency care as any other cron-install step.

## Retention

`RetentionDays` (default 7) maps directly to the S3 lifecycle rule — no
manual cleanup, no separate cron job for expiry. At twice daily and 7 days,
that's 14 backups retained at any time. A longer-term safety net beyond the
rolling window (e.g. one backup/week kept for months, for audit/compliance
reasons beyond pure disaster recovery) needs a second, tag-filtered
lifecycle rule — not included by default since most projects don't need it;
add one if this project does.

## Verify before scheduling

**Do this before installing the cron job**, not after:
```bash
# Run it once by hand, as the same user cron will use:
APP_NAME=<app-name> ENV_SOURCE_MODE=direct SSM_PARAM=/<app-name>/prod/DATABASE_URL \
  BACKUP_BUCKET=<bucket-name> AWS_REGION=<region> ./backup-db.sh

# Confirm it landed in S3:
aws s3 ls s3://<bucket-name>/<app-name>/

# Confirm the lifecycle rule is attached:
aws s3api get-bucket-lifecycle-configuration --bucket <bucket-name>
```

Then actually restore it — into a throwaway database, never straight into
production, even the first time. A backup that's never been restored is a
hope, not a backup. Cheapest safe test, using the instance's own Postgres
(works for both local-Postgres and reachable-external-DB cases):
```bash
aws s3 cp s3://<bucket-name>/<app-name>/<key>.zip ./backup.zip   # from a machine with S3 read access — the instance itself can't (write-only by design)
unzip backup.zip
sudo -u postgres createdb <app-name>_restore_test
sudo -u postgres psql -d <app-name>_restore_test -f <app-name>-<timestamp>.sql
sudo -u postgres psql -d <app-name>_restore_test -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
sudo -u postgres dropdb <app-name>_restore_test
```

## Restoring a backup for real

```bash
aws s3 cp s3://<bucket-name>/<app-name>/<key>.zip ./backup.zip
unzip backup.zip
psql "$DATABASE_URL" -f <app-name>-<timestamp>.sql
```
Or `restore-db.sh <backup.zip> "$DATABASE_URL"` for the same three steps
with an interactive confirmation (it's destructive — `--clean --if-exists`
means it drops/recreates existing objects before loading data back in).

Since the instance's own role can't read the bucket (write-only, by
design), downloading a backup from somewhere other than a machine with
broader S3 access needs a presigned URL generated from wherever that access
does exist:
```bash
aws s3 presign s3://<bucket-name>/<app-name>/<key>.zip --expires-in 300
# on the target machine:
curl -o backup.zip "<presigned-url>"
```

## Gotchas — see `references/gotchas.md` for the full writeups

- Prisma's `?schema=public` breaking `pg_dump` (handled already, see above).
- Some AMIs run SSM's `AWS-RunShellScript` via `sh` (dash), not bash, even
  with bash installed — bash-only syntax in an ad hoc remote diagnostic
  script fails with "Bad substitution" there.
- A DB credential rotation forces a full app reload, which re-reads *all*
  current env vars against *all* current code — can surface an unrelated,
  pre-existing missing/renamed env var that had gone unnoticed since the
  last restart, looking like the rotation broke something it didn't.
- A large payload embedded directly in an SSM `send-command` call hits a
  97KB total document-size limit — upload to S3 first and have the remote
  script download it (or use a presigned URL) instead of base64-embedding
  a big file inline.
