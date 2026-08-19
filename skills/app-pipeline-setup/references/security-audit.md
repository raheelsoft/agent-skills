# Security audit — checking an existing instance

Triggered when the user asks to check, audit, or investigate the security
of an instance — whether this skill provisioned it or not (most real
requests are "why is my site down, can you check the server," which turns
into exactly this). Read-only by default; nothing here modifies the
instance unless a check turns up something actively malicious, in which
case switch to `references/incident-response.md`.

This checklist exists because a real incident worked exactly this way: a
site went down from CPU exhaustion, the cause turned out to be a
cryptominer, cleaning it up once wasn't enough (it came back), and a wider
sweep of "everything else this account can reach" turned up two more
live, unrelated, actively-exploited exposures nobody had asked about.
Don't stop at the first finding — work through the whole list.

## Running this — delegate the investigation, keep containment in the main thread

Sections 1-6 below are read-only investigation across a lot of SSM output
(log tails, configs, `npm audit`, process listings) — delegate the whole
per-instance sweep to a subagent rather than running each command from the
main thread. For more than one instance (see incident-response.md's "Widen
the check"), run one subagent per instance, in parallel — each one blind
to what the others find, reporting back independently.

The subagent's job is investigation and reporting, nothing else — it
returns a structured finding list, not a recommendation or an action:

```
instance_id:        i-0123...
reachable:          true | false — SSM/SSH access. false means say so in
                     the final report, not skip the instance silently.
active_compromise:  true | false — did section 1 find something actively
                     executing right now, not just a historical/config
                     exposure? This is the signal that decides whether
                     incident-response.md's containment step applies.
findings:           one entry per finding, each with: section (1-6),
                     severity (info | exposure | confirmed-active),
                     summary, and the actual evidence (log lines, config
                     content) — not just "looks risky."
```

`active_compromise` is the one field the main thread acts on directly. If
it's `true`, switch to `references/incident-response.md` **in the main
thread**, not inside the subagent — containment (killing a process,
removing a file) is a real, consequential action on a live box, and it
belongs in the visible flow of the conversation, not buried in a
delegated agent's internal trace. The subagent that found it doesn't
decide to contain it; it just makes sure the finding — and the urgency —
actually reaches the main thread.

## 0. Access

- SSM first (`aws ssm describe-instance-information`) — if the instance
  is registered and `Online`, no SSH key is needed for anything below.
- Fall back to SSH only if SSM isn't available and a key exists locally.
- If neither is available for an instance in scope, say so explicitly in
  the final report rather than silently skipping it — an unchecked
  instance is a real gap, not a clean bill of health.
- Every command below runs via `AWS-RunShellScript` (root by default —
  no `sudo` needed) or `sudo -u <app-user>` where a check needs to run as
  the app's own OS user (e.g. reading its own crontab). Build the
  `send-command` payload via `--cli-input-json` from a JSON file, not
  hand-quoted `--parameters` strings — see `references/gotchas.md`'s
  quoting warning; this matters even more here than usual, since a
  malformed command against a live incident wastes time you don't have.

## 1. Active compromise / persistence check (do this first)

- **Anything executing from `/tmp` (or another world-writable path) right
  now**: iterate `/proc/[0-9]*/exe` looking for a target outside normal
  install paths. This is the single highest-signal check — nothing
  legitimate runs a long-lived process from `/tmp`.
  ```bash
  for p in /proc/[0-9]*; do pid=$(basename "$p"); exe=$(readlink "$p/exe" 2>/dev/null); \
    if echo "$exe" | grep -qE '^/tmp/'; then echo "PID $pid -> $exe"; fi; done
  ```
- **`uptime`/`ps aux --sort=-%cpu | head`** — a load average meaningfully
  higher than `nproc` warrants a look regardless of what's causing it.
- **Crontab, both the app user and root** (`crontab -u <user> -l`,
  `crontab -u root -l`) plus `/etc/cron.d/` (exclude the stock
  `certbot`/`e2scrub_all`/`.placeholder` entries — anything else there is
  worth reading in full) and `systemctl list-timers --all`. A real
  incident's persistence mechanism was sitting in the *app user's*
  crontab, not root's — check both, don't assume privileged persistence
  implies a privileged crontab.
- **`authorized_keys`** for every login-shell user (`grep -vE
  '/nologin|/false' /etc/passwd` to find them) — anything beyond what you
  expect is a live backdoor.
- **`/etc/passwd` tail** — any login-shell user that shouldn't exist.

## 2. Network exposure — cross-reference listening ports against the security group

This is the check most likely to be skipped, and it's where the second
and third findings of the real incident came from. A service binding to
`0.0.0.0` is only actually exposed if the security group also allows it —
check both together, not either alone:
```bash
ss -tlnp | grep LISTEN
```
then, locally (not on the box):
```bash
aws ec2 describe-security-groups --group-ids <sg-id> --query "SecurityGroups[0].IpPermissions"
```
Flag anything where a database (5432/3306/6379/27017/...), an app port
that should only be reachable via nginx, or anything else non-web is
allowed from `0.0.0.0/0` — not just SSH. A database open to the internet
with password auth is exploitable regardless of whether nginx or a domain
is involved at all; it doesn't show up in a check that only looks at HTTP
traffic.

## 3. Database access control (if a database is present)

Don't stop at the security group — a security group open to `0.0.0.0/0`
combined with a *correctly* scoped `pg_hba.conf` is still bad practice but
not immediately exploitable; both open at once is what makes it live:
```bash
find /etc/postgresql -name 'pg_hba.conf' -exec cat {} \; | grep -v '^#' | grep -v '^$'
```
`host all all 0.0.0.0/0 md5` (or `trust`, which needs no password at all)
means anyone on the internet can attempt to authenticate. Check the
database's own log for evidence of active probing before assuming it's
just a theoretical risk:
```bash
tail -200 /var/log/postgresql/postgresql-*-main.log | grep -iE 'connection received|authentication failed|FATAL'
```
Repeated `password authentication failed for user "postgres"` /
`"test"` / `"admin"` at a steady interval is automated scanning, not a
one-off — treat it as an active, ongoing attack, not a historical
curiosity, even if every attempt so far has failed.

## 4. SSH posture

- Security group: is 22 open to `0.0.0.0/0`, or scoped to specific IPs?
- If open to the world, check whether it's actually exploitable before
  panicking further: `grep -iE '^\s*PasswordAuthentication|^\s*PermitRootLogin' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf`.
  `PasswordAuthentication no` means brute-force scanning (which there
  will be plenty of — this is normal internet background noise on any
  open port 22) can't succeed regardless of volume; key-only auth is a
  real mitigating factor, not just theoretical.
- Either way, check for actual successful logins from unexpected sources
  across **every** rotated log, not just the current one — an attacker
  who got in once has no reason to keep reconnecting from the same IP:
  ```bash
  zgrep -a Accepted /var/log/auth.log* 2>/dev/null
  ```
  Read the matched lines carefully — `zgrep -a Accepted` also matches
  `PubkeyAcceptedAlgorithms` rejection messages (an *unsuccessful*
  attempt using a deprecated key algorithm), not just real logins. Confirm
  each match is actually `Accepted publickey`/`Accepted password`, not a
  substring false positive, before concluding anything about who got in.

## 5. Web-facing exposure — nginx configs

Read every file in `/etc/nginx/sites-enabled/` in full, not just the
`server_name`s:
```bash
for f in /etc/nginx/sites-enabled/*; do echo "--- $f ---"; cat "$f"; done
grep -r auth_basic /etc/nginx/
```
Specifically look for:
- Any domain that sounds like it should be internal/staff-only (`admin.*`,
  `cms.*`, `internal.*`, a bare `api.*` with no rate limiting) with no
  `auth_basic`, no IP `allow`/`deny`, nothing — fully public by omission,
  which is easy to miss since the config isn't *wrong*, it's just missing
  a layer nobody added.
- `auth_basic` directives that are present but **commented out** — a
  protection that was deliberately disabled at some point and never
  re-enabled reads identically to one that was never added, at a glance.
- The port each `location` proxies to, cross-referenced against step 2's
  listening-port scan — confirms nginx is actually the only path in, not
  one of several.

## 6. Dependency vulnerabilities

For each Node app found (check `pm2 list` or `ps aux` for `cwd`s):
```bash
git -c safe.directory='*' -C <app-dir> log --oneline -25
npm audit --production
cat <app-dir>/node_modules/next/package.json | grep '"version"'  # or whichever framework
```
Prioritize anything `high`/`critical`, and check the actual installed
version against the framework's advisory list even if `npm audit` doesn't
flag it directly — an old lockfile can under-report. Cross-reference the
git log for the same date range against any other finding (a compromise
date from step 1, say) — legitimate commits from known contributors, with
descriptive messages, rule out an injected-commit theory; if that's clean
and the framework has real known vulnerabilities, a direct network
exploit against the web app is the more likely story than a supply-chain
one, not the other way around.

## Reporting

Merge every subagent's findings into one report structured by severity,
not by instance or by which subagent found it — a critical finding on an
unimportant-sounding box outranks a clean sweep of five others. Carry each
finding's evidence through as-is (not just "looks risky" — the actual log
lines/config), and whether it's confirmed exploited or just exposed. Say
plainly which instances (if any) came back `reachable: false` — an
unchecked instance is a gap, not a clean result, and it's easy to lose
that fact once everything's merged into one report.

Don't fix anything found on infrastructure outside what was explicitly
asked about (a second app, a different client sharing the same AWS
account) without asking first — flag it and wait, per Step 3's
confirmation-gate discipline everywhere else in this skill.
