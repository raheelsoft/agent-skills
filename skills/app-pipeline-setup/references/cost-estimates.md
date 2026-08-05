# Rough cost estimates

Used by Step 3's confirmation gate (before creating anything) and Step 14's
summary (after, as an actual line-item recap). These are **rough,
on-demand, us-east-1-ish public pricing gut-checks**, not quotes — say so
explicitly whenever giving one, and point to the AWS Pricing Calculator for
anything the user wants to pin down precisely. Prices drift and vary by
region; don't present these as current-to-the-dollar.

## Per resource, approximate monthly cost

- **EC2 `t3.micro`**: ~$7-8/mo compute (on-demand, running 24/7) + ~$1.60
  for a 20GB gp3 root volume. `t3.small`/`t3.medium` roughly double/quadruple
  the compute line.
- **Elastic IP** (`AssignElasticIp=true`, the default — Step 2 asks
  explicitly): free while attached to a running instance; ~$3.60/mo if
  ever left unattached (stopped instance, or released and re-requested).
  `AssignElasticIp=false` avoids this entirely by using the subnet's
  dynamic public IP instead — genuinely free, but that IP changes on
  stop/start, which is a real problem the moment a domain points at it.
- **RDS `db.t3.micro` Postgres, single-AZ**: ~$12-13/mo compute + ~$2.30
  for 20GB gp3 storage + a small amount for backup storage beyond the free
  allowance. `MultiAZ=true` roughly doubles the compute line.
- **S3**: storage is ~$0.023/GB/mo (private/public bucket), requests are
  fractions of a cent per thousand — for a typical small app's assets or
  static site, usually **under $1/mo** unless traffic/storage is
  significant.
- **CloudFront**: ~$0.085/GB for the first 10TB (PriceClass_100 regions) +
  ~$0.01 per 10,000 requests — for a small-to-medium site, often a few
  dollars a month, but scales with real traffic; mention this scales
  differently from the flat EC2/RDS lines above.
- **Route53**: $0.50/mo per hosted zone + ~$0.40 per million queries —
  negligible for most apps.
- **CloudWatch**: alarms are ~$0.10/mo each (2 alarms = ~$0.20); Logs
  ingestion/storage for pm2 logs is usually well under $1/mo for a small
  app unless logging volume is unusually high.
- **SNS**: functionally free at this scale (first 1,000 email
  notifications/mo free, then fractions of a cent each).
- **Database backup bucket** (`db-backup.yaml`, `references/db-backups.md`):
  effectively negligible — small `.sql.zip` dumps, short (default 7-day)
  retention, low request volume from a twice-daily cron job. Usually a few
  cents a month, not worth its own line in a totals estimate below.
- **Route53 health check** (`uptime-check.yaml`): ~$0.50/mo for a basic
  HTTP/HTTPS check at the standard (30s) interval; the "fast" 10s interval
  costs more (~$1-2/mo) — a separate line item from the hosted-zone/query
  cost above, easy to conflate since both are Route53.
- **NAT Gateway**: **not used anywhere in this skill's templates** — the
  EC2 instance sits in a public subnet with a direct Elastic IP, so there's
  no ~$32/mo NAT Gateway line item to worry about. Worth confirming this
  explicitly if a user asks about a specific cost, since NAT is a common
  surprise line item in other people's AWS setups.
- **CodePipeline (V2, `PipelineType: V2`/`ExecutionMode: QUEUED` —
  `templates/cfn/pipeline.yaml`/`static-site-pipeline.yaml`)**: usage-based
  (per pipeline-execution-minute of active-stage time), not V1's flat ~$1/mo
  per active pipeline. For a small app deploying a handful of times a day
  this is typically still just a few dollars a month, but it scales with
  deploy frequency rather than being a flat line — worth saying so
  explicitly rather than quoting V1's flat number, which no longer applies
  here.
- **EC2 data transfer out**: the most variable, most easily-surprising line
  item — ~$0.09/GB after a small monthly free allowance, scaling directly
  with real traffic rather than being a flat number like the lines above.
  A low-traffic app's data transfer is negligible; a suddenly-popular one
  can make this the single largest line on the bill. Say so explicitly
  rather than folding it into a flat total — it's the one number here that
  genuinely can't be estimated without knowing expected traffic.

## Rough totals for common shapes

- **Single small app, EC2 + local Postgres, no domain**: roughly $10-12/mo.
- **Single small app, EC2 + RDS + S3 + notifications, with a domain**:
  roughly $25-30/mo.
- **Frontend + backend for the same product, sharing one EC2 instance under
  one domain** (`templates/app/nginx-combined.conf.tmpl` — see SKILL.md
  Step 11): the cheapest two-app shape — one instance, one Elastic IP, one
  cert (certbot's `-d` flags cover one domain, no second one needed since
  there's no second domain), no CORS/cross-origin setup between them. This
  is the same base EC2 line item as the single-app estimate above, not
  double it — mention this explicitly when a user is deciding between one
  shared domain and two separate ones (e.g. `api.example.com` +
  `app.example.com`, which does need a second cert/domain but keeps the
  two apps' nginx configs and rate limits fully independent). Neither
  choice is "correct" — cost favors combined, isolation favors separate.
- **Static-site frontend only (S3+CloudFront, low-moderate traffic)**:
  often **under $5/mo** — this is the cost argument for offering the
  static path in the first place (`references/static-site-conversion.md`).
- **Staging + production, each roughly matching one of the above**: sum
  them — staging isn't free just because it's staging, though its instance
  size/RDS class defaults are cheaper (`references/staging-environment.md`).

None of the totals above include data transfer out — mention it separately
as a variable, traffic-dependent add-on rather than folding a guess into
the flat number.

## How to present this

State it as a range with the on-demand/rough caveat up front, not a bare
number that reads like a committed quote: *"Roughly $X-Y/month at current
on-demand pricing, mainly driven by [the 1-2 largest line items] — worth
checking the AWS Pricing Calculator if you want it pinned down exactly."*
