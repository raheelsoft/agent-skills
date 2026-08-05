# DNS / Route53

## Deciding what to do

Ask in the interview whether the domain's DNS is managed in **Route53**
(AWS) or **elsewhere**. "Elsewhere" covers any registrar/DNS host —
GoDaddy, Cloudflare, Namecheap, Google Domains, Squarespace Domains,
whatever — the record types involved (A, ALIAS/ANAME, CNAME) are a
standard concept every one of them supports, only the panel UI differs.
This changes what the skill can do for you:

- **Route53**: the skill creates the DNS record(s) itself — no manual step.
- **External registrar**: the skill still computes the record's target
  value (Elastic IP, or CloudFront domain for the static-site path), but
  can't create the record itself — it hands the user a structured report
  of exactly what to add (see "Reporting records for an external
  provider" below), the same information the original discoverytown build
  gave manually, just formatted consistently and appended to the skill's
  final response rather than left implicit.
- **No domain yet**: skip DNS entirely — the app is reachable by Elastic
  IP / CloudFront domain only.

If "elsewhere" is chosen, ask a quick follow-up: **which provider** —
offer GoDaddy / Cloudflare / Namecheap / "other" as options. Not required
to proceed (generic instructions work everywhere), but lets the report
below include the right panel navigation and catch the one common gotcha
(Cloudflare's proxy) before it causes a confusing failure.

## Provider-specific notes

| Provider | Where to add records | Gotcha |
|---|---|---|
| GoDaddy | Domain → DNS → Manage Zones → Add | None significant. |
| Cloudflare | DNS → Records → Add record | **Set Proxy status to "DNS only" (grey cloud), not "Proxied" (orange cloud), for any record this skill creates.** A proxied record breaks certbot's HTTP-01 challenge (traffic hits Cloudflare's edge, not the box) and breaks a CloudFront alias record's intended behavior (Cloudflare would be proxying to CloudFront, doubling up CDNs pointlessly and likely breaking ACM DNS validation CNAMEs the same way). |
| Namecheap | Domain List → Manage → Advanced DNS → Add New Record | Namecheap doesn't support ALIAS/ANAME at the apex for third-party CNAME-like targets on all plans — an apex domain pointing at CloudFront may need Namecheap's own "ALIAS Record" type if available, otherwise use a `www` subdomain (CNAME) and redirect the apex, or move DNS to Route53. |
| Other/unknown | Look for "DNS", "DNS Management", or "Zone Editor" in the provider's dashboard | Ask the user to confirm the record saved and propagated (`dig`/`nslookup`) since the skill can't check the provider's UI itself. |

## Check for an existing hosted zone first

A domain "being on AWS" usually means a Route53 hosted zone already exists
for it:
```bash
aws route53 list-hosted-zones-by-name --dns-name <domain> \
  --query "HostedZones[?Name=='<domain>.'].{Id:Id,Name:Name}" --output table
```
If found, use its `Id` (strip the `/hostedzone/` prefix) directly — don't
create a second zone for the same domain.

## Creating a hosted zone (only if genuinely none exists)

This is a new-resource creation — covered by Step 3's confirmation gate.
Deploy `templates/cfn/hosted-zone.yaml`, then read the `NameServers`
output. **Creating the zone does not make it authoritative** — the
domain's registrar still needs its nameservers updated to point at this
zone's four `NameServers` values, which is a manual step at the registrar,
same category as the CodeStar Connection OAuth step
(`references/codestar-connection-setup.md`) — cannot be automated from
here, and DNS propagation for a nameserver change can take hours. Tell the
user this plainly rather than implying the zone alone is sufficient.

## Creating the record

Deploy `templates/cfn/dns-record.yaml` once per record needed (once for the
apex domain, again for `www` if both are wanted):

- **EC2-hosted app** (backend, or frontend on EC2): `TargetType=ip`,
  `TargetIp=<PublicIp from ec2-instance.yaml's output>`. This should be a
  stable Elastic IP (`AssignElasticIp=true`) — pointing DNS at the
  subnet's dynamic IP works until the instance's next stop/start, then
  silently breaks. If `AssignElasticIp=false` was chosen earlier and a
  domain is only now being added, that's worth revisiting rather than
  wiring DNS to an IP that's about to change.
- **Static-site frontend** (S3+CloudFront path, see
  `references/static-site-conversion.md`): `TargetType=cloudfront`,
  `TargetCloudFrontDomain=<CloudFront distribution domain>` — this must be
  an Alias record, not a plain A record, since CloudFront has no static IP.

## Certbot vs ACM

The EC2 path still uses certbot for TLS (Step 11 in SKILL.md) regardless of
where DNS lives — certbot's HTTP-01 challenge just needs the domain to
resolve to the box, which the record above provides either way.

The static-site path needs an ACM certificate instead (CloudFront can't use
certbot — there's no server to run it on). ACM certificates for CloudFront
must be requested in **us-east-1** specifically, regardless of the app's
actual region — this is a hard CloudFront requirement, not a default to
second-guess. If DNS is in Route53, ACM's DNS validation can be automated
(create the CNAME validation record the same way as the A record above); if
DNS is external, the user has to add the validation CNAME manually and the
skill should wait/poll for `Status: ISSUED` before attaching the cert to
CloudFront — this validation CNAME is itself one more row in the report
below, and typically needs adding *before* the app's own A/CNAME record
since the cert has to issue first.

## Reporting records for an external provider

Whenever DNS is external, render `templates/app/dns-records-report.md.tmpl`
and include its output directly in the skill's response (Step 14 in
SKILL.md) — not just a reference doc buried for later, the actual records
belong in the answer the user reads. No secrets are involved, so unlike
`local-dev-env-report.md.tmpl` this doesn't need special file-handling —
paste it straight into the chat reply.

Build `___RECORDS_TABLE___` as one markdown table row per record actually
needed, in the order they should be added (validation before the app
record, if both apply):

- EC2 path: one row — `A | <domain> | <PublicIp> | 300 | Points the app at its instance` (should be a stable Elastic IP, not the dynamic subnet-assigned one — see the caveat above)
- Static-site path, no custom domain skipped: one row —
  `A (ALIAS/ANAME) | <domain> | <CloudFront domain> | — | Points the app at CloudFront (some providers call this CNAME instead — see the provider table above)`
- Static-site path with a custom domain: **also** one row for the ACM
  validation CNAME, sourced from
  `aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[0].ResourceRecord'` —
  `CNAME | <ResourceRecord.Name> | <ResourceRecord.Value> | 300 | Proves domain ownership to ACM — the cert won't issue without this`

Build `___PROVIDER_NOTES___` from the provider table above, scoped to
whichever provider the user named (or a generic note if they said
"other"/didn't say) — always include the Cloudflare proxy warning
verbatim if they said Cloudflare, it's the one gotcha that silently breaks
things rather than just failing loudly.
