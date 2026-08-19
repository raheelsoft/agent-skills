# Security defaults baked into infra creation

`references/security-audit.md` and `references/incident-response.md` are for
checking or cleaning up an instance *after* the fact — including one this
skill never touched. This doc is the other half: what this skill itself
guarantees about anything it provisions from scratch, so those don't need to
be rediscovered later by an audit. Every item below is grounded in a real
production incident — a live cryptomining compromise, traced most plausibly
to a fully public admin panel running outdated software with known CVEs, on
a box that also turned out to have unrelated database exposures (a security
group opening 5432/3001/3002 straight to `0.0.0.0/0`, and `pg_hba.conf` set
to `host all all 0.0.0.0/0 md5`) under active internet-wide brute force. None
of that infrastructure was built by this skill — but the failure modes are
exactly the ones to design out here.

## Network exposure

- **Security group never opens the app's own port or a database port.**
  `templates/cfn/ec2-instance.yaml`'s `SecurityGroup` only ever has rules for
  80, 443, and (conditionally, per an explicit CIDR) 22 — see that
  resource's own inline comment. The app is only ever reached through
  nginx's reverse proxy; a database is only ever reached over localhost (a
  local Postgres/Redis) or the app's own security group (RDS, via
  `rds-instance.yaml`'s `AppInstanceSecurityGroupId` parameter). If a user
  asks to open the app or DB port directly — "just for a moment," "just to
  debug," "just from my IP" — that's a real request to weigh, but the
  default is closed, and the answer isn't to quietly add an ingress rule.
  Use an SSM port-forward session (`aws ssm start-session --target <id>
  --document-name AWS-StartPortForwardingSession --parameters
  '{"portNumber":["5432"],"localPortNumber":["5432"]}'`) instead — same
  practical result, no security group change, nothing to remember to revert.
- **SSH is closed by default.** Step 2b asks explicitly and never defaults
  to `0.0.0.0/0` — see `SKILL.md`'s Batch 2. Administration goes through SSM
  Session Manager, which needs no open port and no key at all.

## Database

- **Local Postgres binds to localhost, explicitly, not by inherited
  default.** `server-bootstrap.sh.tmpl` (run over SSM, not CloudFormation
  UserData — see `references/server-bootstrap.md`) forces `listen_addresses
  = 'localhost'` in `postgresql.conf` right after install, rather than relying
  on whatever a given Ubuntu version ships as its own default — a default
  that could change, and shouldn't be the only thing standing between the
  database and the internet anyway. Combined with the security-group rule
  above, this is defense in depth: either control alone would already
  prevent the exposure that was actually found on a real box, but both exist
  because relying on exactly one control is how that box's exposure
  happened in the first place (a security group opened by hand, at some
  point, with nothing else in the way once it was).
- **Never widen `pg_hba.conf` to `0.0.0.0/0`.** This skill's default install
  never touches `pg_hba.conf` at all — the Ubuntu package default (local
  Unix-socket auth for same-box connections) is sufficient given the network
  controls above. If a future need for remote database access comes up
  (a BI tool, a teammate's laptop), that's an explicit, scoped decision —
  a specific IP or a bastion/tunnel — never a blanket `all all 0.0.0.0/0`
  line, which is what a real, currently-exploited box had.
- **Managed RDS is scoped by security group, not a public endpoint** —
  `rds-instance.yaml` takes the app instance's own security group ID as a
  parameter specifically so ingress is `AppInstanceSecurityGroupId ->
  5432`, never `0.0.0.0/0 -> 5432`. RDS's own default (`PubliclyAccessible:
  false`, implicitly) is left alone, not overridden.

## Exposed admin/internal panels

- An app that **is** an admin panel, dashboard, or CMS — not just an API
  with one restricted path — gets an active recommendation (not just a
  neutral ask) to gate the whole thing behind HTTP Basic Auth and/or an IP
  allowlist. See `SKILL.md` Step 2b's Basic Auth bullet and
  `references/basic-auth-gating.md` for the mechanism (`satisfy any; allow
  <cidr>; deny all; auth_basic ...;` — password-fallback for IPs not on the
  list, rather than a hard lockout). This is the single highest-value
  question this skill can ask, because the real incident this doc is
  grounded in most plausibly started here: a fully public admin panel,
  outdated framework, known CVEs, nothing in front of it at all.

## Dependency hygiene

- **`npm audit` runs at Step 1, before anything is provisioned**, and its
  `high`/`critical` count is carried into Step 3's confirmation manifest —
  not to block the deploy (patching first vs. deploying now and patching
  after is the user's call), but so that call is actually informed. An app
  going live with known, unpatched `high`/`critical` CVEs already in it is
  a materially different decision than one going live clean, and the user
  should get to make that decision knowingly rather than discover it during
  an incident.

## What this doesn't cover

This list is about what's true the moment this skill finishes provisioning.
It says nothing about drift afterward — a security group rule added by hand
next month, a `pg_hba.conf` loosened for a one-off task and never reverted,
a dependency that was current at deploy time and isn't anymore. That's
exactly what `references/security-audit.md` is for; run it periodically on
anything long-lived, not just once at creation.
