# Incident response — something in `references/security-audit.md` came back active

For when the audit finds a live compromise (a running malicious process,
active persistence), not just an exposure. The distinction matters: an
*exposed* database with no evidence of successful access is a
misconfiguration to fix; a *running* unauthorized process is an incident
to contain first, investigate second.

## 1. Contain — kill it, restore service

If the finding is actively consuming resources or is confirmed malicious
(not just suspicious), containing it is time-sensitive enough to act on
immediately once confirmed — don't let confirmation work (step 2 below)
delay stopping active harm:
```bash
kill -9 <pid>
rm -f <the dropped files>
```
Verify the fix actually restored the site/service (not just that the
process is gone) — hit the real endpoint, don't assume:
```bash
curl -sS -o /dev/null -w "%{http_code} in %{time_total}s\n" --max-time 15 -L https://<domain>/
```

## 2. Confirm what it actually is before writing up anything

Don't report "found a cryptominer" from process name alone — check what
it's actually doing:
```bash
file /tmp/<binary>
cat /tmp/<config-file-if-any>
```
A miner writes its own log with unambiguous evidence (pool address,
algorithm, hashrate) — if one exists, read it; it turns "probably a
miner" into "confirmed XMRig connecting to pool X," which is a much more
useful thing to hand to whoever owns the box next.

## 3. Remove the persistence, not just the running process

Killing the process without finding how it comes back means it comes
back — confirmed behavior, not a hypothetical: the same box got
reinfected within 15 hours of the first cleanup in a real incident,
independent of anything the responder did wrong. Before declaring it
handled:
- Re-run `security-audit.md`'s step 1 (crontab/systemd/authorized_keys)
  in full — a persistence mechanism found and removed once doesn't mean
  it's the only one.
- **Back up whatever's being removed before removing it** — a crontab in
  particular (`crontab -u <user> -l > backup-file` before `crontab -u
  <user> -r`) — the removed content is itself evidence for whoever
  eventually finds the actual entry point.
- If a persistence mechanism looks broken (e.g. missing a `sudo` it
  needed, silently failing every run) — that's worth confirming, not
  assuming: check whether its intended effect (a new user, a new sudoers
  file, a started container) actually exists. A broken persistence
  attempt is good news, but "it's in the crontab" isn't the same claim as
  "it worked" — verify which one is actually true before saying so.

## 4. Find the entry point — don't stop at "process removed"

Work through, roughly in this order (cheapest/most-conclusive first):
1. **SSH logs, every rotated file, both accepted and failed** — if
   completely clean (only known IPs, zero unauthorized successes), that
   rules out a whole category and narrows what's left.
2. **Git history** around the suspected compromise window — commits from
   known contributors with normal messages rules out an injected-commit
   supply-chain theory; don't assume that theory without checking it.
3. **`npm audit` on every app on the box** — real, currently-unpatched
   `high`/`critical` vulnerabilities in internet-facing software are
   concrete, checkable evidence, not speculation, and in a real incident
   turned out to be the most defensible conclusion once SSH and git were
   ruled out.
4. **nginx config** — is there a fully public admin/internal panel
   running the vulnerable software identified in step 3? That combination
   (open access + known exploitable bug) is the story, not either fact
   alone.

Say plainly when the entry point is a strong inference rather than
proven — historical web-server logs frequently don't reach back far
enough to catch the actual moment, and overclaiming certainty here leads
to the wrong remediation priority.

## 5. Stopgap while the real fix is pending

If the actual fix (a dependency upgrade, closing an exposed port) is a
real code/infra change that needs review and can't happen immediately,
and the compromise has already recurred once, don't just wait — put a
watchdog in place so a second recurrence doesn't cause another outage
while the real fix is in progress. Render
`templates/app/scripts/security-watchdog.sh.tmpl` (no placeholders — ask
first whether it should target the exact known-malicious pattern from
this incident, or the more general "anything executing from `/tmp`"
default) and install it via a **root** crontab entry, deliberately not
the app user's — the app user's own crontab is exactly where the original
persistence lived, so don't put the fix in the same place the attacker
would look first:
```bash
crontab -u root -l 2>/dev/null   # check what's already there first, don't clobber it
echo '*/2 * * * * /usr/local/bin/security-watchdog.sh' | crontab -u root -
```
Make the script itself root-owned and `700` so the (possibly still
partially compromised) app user can't read or tamper with it:
```bash
chmod 700 /usr/local/bin/security-watchdog.sh
chown root:root /usr/local/bin/security-watchdog.sh
```
Tell the user explicitly this is a stopgap, not a fix, and give the exact
two-line removal command for once the real fix ships — an undocumented
standing cron job left behind after the real issue is patched is its own
small, low-grade version of the confusing-undocumented-infra problem this
whole skill exists to avoid.

## 6. Widen the check — don't stop at the one instance

If this instance shares an AWS account with others, sweep them too
(`references/security-audit.md`'s section 1 at minimum, across every
reachable instance) before considering the incident closed — a real
incident's second and third findings were on completely different,
previously-unmentioned instances, found only because the check was run
account-wide instead of stopping at the one instance that was reported
down. Don't silently skip an instance that isn't reachable (no SSM
registration, no key available) — say so explicitly in the report; an
unchecked instance is a gap, not a clean result.

## 7. Report and hand off

Structure per `references/security-audit.md`'s "Reporting" section.
Additionally: never fix a finding on infrastructure the user didn't
explicitly ask about — a second app, a different team's instance sharing
the account — without asking first, even mid-incident when the instinct
is to just fix everything found. Flag it, explain the risk, wait for a
yes, same confirmation-gate discipline as the rest of this skill.
