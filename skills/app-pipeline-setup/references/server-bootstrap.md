# Server bootstrap — SSM-driven, not CloudFormation UserData

## Why bootstrap lives here and not in CloudFormation UserData

Installing nginx/Node/pm2/Postgres/etc. directly in `ec2-instance.yaml`'s
UserData, blocking `aws cloudformation deploy` on a `cfn-signal` until it
finished, looks like the obvious approach — CloudFormation's own docs lead
you straight there. It's also the wrong place for it: CloudFormation's job
is provisioning (create the AWS resources), not configuration (install and
configure things inside them), and UserData is a **one-shot script** — it
runs once at instance creation and cannot be re-invoked by a stack update
(changing an instance's properties later is a stop/start, not a fresh
boot). Building the first real instance this way surfaced exactly the two
failures that one-shot nature guarantees eventually happen:

- **No way to retry after a resize.** An instance too small for its Node
  build has nowhere to go — UserData already ran (or OOM-killed partway
  through), and there's no "just try again on a bigger box." See
  `references/gotchas.md`'s "Bootstrapping the server via CloudFormation
  UserData doesn't survive a resize or a second app."
- **No way to add a capability to an existing instance.** Targeting an
  existing instance for a second app that needs Postgres, when the box was
  never provisioned with it — UserData for that instance is long gone, so
  the gap is silent until the second app fails to start.

The fix: `ec2-instance.yaml` now provisions only the instance, security
group, IAM role, EBS volume, alarms, and Elastic IP — no `CreationPolicy`,
no `cfn-signal`, no UserData. Everything else (nvm/Node/pm2, nginx,
certbot, AWS CLI v2, optional Postgres/Redis/Docker, the CloudWatch Agent,
and the two shared `app-pipeline-deploy.sh`/`app-pipeline-rollback.sh`
scripts) lives in `templates/app/scripts/server-bootstrap.sh.tmpl`,
rendered via `scripts/render.sh` and run over SSM RunCommand — the same
mechanism this skill already uses for deploys, not a new pattern — with
every step written idempotent specifically so it can be safely retried or
re-run.

## The flow (SKILL.md Step 4b)

1. After `aws cloudformation deploy` returns (now fast — it's only
   waiting on EC2/IAM/SG creation, not a full package install), poll for
   SSM registration:
   ```
   aws ssm describe-instance-information --filters Key=InstanceIds,Values=<id> \
     --query 'InstanceInformationList[0].PingStatus' --output text
   ```
   Wait for `Online` (Ubuntu's official AMI ships the SSM Agent
   pre-installed and running — this is normally under a minute, not the
   old 20-minute `BootstrapTimeoutMinutes`). If it's not online within a
   few minutes, that's a real problem worth surfacing directly (bad AMI,
   SG/IAM misconfiguration) — not a case for the resize flow below, which
   is specifically about install-time resource exhaustion, not
   connectivity.

2. Render `server-bootstrap.sh.tmpl` with this run's values (`AppName`,
   `NodeMajorVersion`, `NvmVersion`, `NeedsPostgres`, `NeedsRedis`,
   `EnableDocker`, `SwapSizeGB`, `OsUser` — same names as the old CFN
   parameters, just consumed here instead of by CloudFormation) and push
   it over SSM RunCommand (`AWS-RunShellScript`).

3. **Delegate the run to a subagent** — it sends the command, polls
   `get-command-invocation` until done, and reports back. This keeps the
   apt/npm/dpkg output and the polling loop out of the main thread's
   context, but the subagent's job stops at reporting; it never decides
   what happens next.

## The subagent's report contract

The subagent must return a structured report, not a recommendation:

```
outcome:      succeeded | failed
category:     likely-undersized | script-error | permission-error | network-error | unknown
              (omit if outcome is succeeded)
evidence:     concrete signal, quoted — e.g. "dmesg shows OOM killer killed
              `npm install -g pm2` (pid 4821) at 14:32:07Z; `free -m` showed
              0MB available, swap 512/512MB used"
raw_log_ref:  the SSM command ID, and/or /var/log/app-pipeline-bootstrap.log
              on the box — so the user can pull the full log if they want
              it, without it being dumped into the main thread by default
```

`category` must be backed by an actual check, not a guess from "it took a
while" or "it failed partway through." Concretely:

- **`likely-undersized`**: `dmesg | grep -i "killed process"` shows the
  OOM killer fired, OR `free -m` at the time of failure shows swap fully
  exhausted with near-zero available memory. Either is a real, checkable
  signal — not "the install seemed slow."
- **`script-error`**: a command failed with a normal non-OOM error (bad
  syntax, a package that doesn't exist, a real command failure) — report
  the actual error, don't reach for a sizing explanation.
- **`permission-error`** / **`network-error`**: self-explanatory from the
  command's own output (403/permission denied, DNS failure, timeout
  reaching a package mirror).
- **`unknown`**: none of the above matched — say so plainly rather than
  defaulting to `likely-undersized`, which is the one category that
  implies spending more money.

## What the main thread does with the report (the gating rule)

**Every infra-affecting decision is a question, never automatic** — this
applies uniformly, not just to the first creation. Specifically for a
`likely-undersized` report:

1. Ask, quoting the actual evidence, with the cost delta from
   `references/cost-estimates.md`:
   > "The install failed — `dmesg` shows the OOM killer killed `npm
   > install`, swap was fully exhausted on `t3.micro`. Want me to resize
   > to `t3.small` (~+$8/mo) and retry, or handle it another way?"
2. Only on an explicit yes: resize per the mechanics in
   `references/gotchas.md` — preview via
   `aws cloudformation deploy --no-execute-changeset` first, confirm it
   shows an in-place update (`interruption: yes, replacement: no`) on
   `InstanceType` alone, then execute. This is a stop/start on the *same*
   instance (no UserData to worry about re-running, since bootstrap isn't
   in UserData anymore).
3. Re-render and re-run `server-bootstrap.sh.tmpl` over SSM — safe because
   every step in it is idempotent (see the template's own header comment).
4. **Cap at one resize hop.** If it fails again after the resize, stop and
   say so plainly — "this doesn't look like a sizing problem anymore" —
   rather than offering a second, bigger resize. A script bug doesn't get
   fixed by more RAM, and an uncapped retry loop against a
   `likely-undersized` category that keeps re-triggering is exactly the
   failure mode this cap exists to prevent.

For every other category (`script-error`, `permission-error`,
`network-error`, `unknown`), there is no resize question at all — report
the evidence and let the user decide what to do; don't default to "try a
bigger box" for a problem that was never about size.

## Idempotency requirement for anything added to server-bootstrap.sh.tmpl

Because this script may legitimately run more than once against the same
instance (a failed-then-retried run, or a later run adding a capability
for a second app), every step needs one of:

- A natural no-op on re-run (`apt-get install -y <pkg>` on an
  already-installed package, a heredoc overwrite with identical content).
- An explicit existence check before creating (the swap-file guard, the
  nvm-already-installed guard already in the template).

Never add a bare create-or-fail call (e.g. an unconditional `mkswap`) —
that's exactly the pattern that made UserData unsafe to re-run in the
first place, just moved to a different script.
