# Managed RDS database

`templates/cfn/rds-instance.yaml` is the recommended alternative to
`ec2-instance.yaml`'s `NeedsPostgres=true` option. Local Postgres on the app
box can now get automated backups too (`references/db-backups.md`), but RDS
still has real advantages worth weighing: **point-in-time recovery** within
the retention window (not just discrete daily/twice-daily snapshots), and
backups that survive the app instance being terminated *and* the backup
mechanism itself (a box-level cron job dies with the box; RDS's automated
backups are entirely independent of it). `BackupRetentionPeriod` (default 7
days) controls RDS's own window.

## Master password handling

The template sets `ManageMasterUserPassword: true` — RDS generates the
password itself and stores it in a Secrets Manager secret it also manages
(rotation-ready, though rotation isn't enabled by default here). This skill
never chooses, types, or stores that password anywhere itself.

After deploying the stack:
```bash
aws secretsmanager get-secret-value --secret-id <MasterUserSecretArn from stack output>
```
This returns a JSON string containing `username`/`password`. Build
`DATABASE_URL` from that plus the stack's `Endpoint`/`Port`/`DatabaseName`
outputs (e.g. `postgresql://<user>:<password>@<endpoint>:<port>/<dbname>`),
and carry it straight into Step 9, where it becomes its own
`/{app-name}/prod/DATABASE_URL` parameter (see
`references/env-parameter-store.md`). Never print the password itself
anywhere else in the conversation or in any log-producing command after
this.

## Network access

`AppInstanceSecurityGroupId` (the `SecurityGroupId` output from
`ec2-instance.yaml`) is the only thing allowed to reach port 5432 —
`PubliclyAccessible: false`, and the DB's own security group only
source-references that one SG, not a CIDR. If a second app instance (e.g. a
staging environment, or a worker box) needs DB access too, that instance's
security group needs its own ingress rule added — either redeploy this
stack with an additional SG reference, or add a second
`AWS::EC2::SecurityGroupIngress` resource pointing at the new SG.

## Sizing and durability knobs — always ask, don't default silently

Same rule as the EC2 instance type: `DBInstanceClass`, `MultiAZ`, and
`BackupRetentionPeriod` meaningfully affect both cost and durability. Don't
pick `db.t3.micro`/`MultiAZ=false`/7-day retention without confirming
they're appropriate — production apps often want `MultiAZ=true` and a
longer retention window; a disposable staging DB usually wants the cheapest
option and `DeletionProtection=false` (see `references/staging-environment.md`).

## `EngineVersion` goes stale

Unlike the EC2 template's AMI (resolved live via an SSM public parameter),
RDS has no equivalent "always current" mechanism for Postgres engine
versions — AWS deprecates old ones over time. Verify the template's default
is still supported before deploying:
```bash
aws rds describe-db-engine-versions --engine postgres --query "DBEngineVersions[].EngineVersion"
```
