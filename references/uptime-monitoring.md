# Continuous uptime monitoring

`templates/cfn/uptime-check.yaml` fills a real gap the rest of this skill
leaves open: `validate_service.sh` only checks health *during* a deploy,
and `ec2-instance.yaml`'s CloudWatch alarms only watch the box (disk,
instance status) — nothing continuously checks whether the app itself is
still actually responding hours or days after a successful deploy. A crash
loop, an out-of-memory pm2 restart failure, or an expired dependency could
all go unnoticed until a user reports it.

This is opt-in (Step 2, offered alongside the notification email question)
— it's a new, continuously-running billable resource
(`references/cost-estimates.md` has the ~$0.50-1/mo figure for the
recommended 30s-interval standard check), not something to add silently.

## Deploy — us-east-1, always

Like ACM certificates for CloudFront, Route53 health check metrics are
only published to CloudWatch in **us-east-1**, regardless of where the
app or its other stacks live. Deploy with `--region us-east-1` explicitly:

```bash
aws cloudformation deploy --region us-east-1 \
  --stack-name <app-name>-uptime \
  --template-file templates/cfn/uptime-check.yaml \
  --tags Project=<project-tag-value> \
  --parameter-overrides AppName=<app-name> TargetType=<domain|ip> \
    FullyQualifiedDomainName=<domain-or-empty> IpAddress=<eip-or-empty> \
    ResourcePath=<same health-check path as validate_service.sh> \
    NotificationTopicArn=<arn-or-empty>
```

Deploy this **after** the app is actually live (Step 12's verification, or
SS5 for the static-site path) — a health check against an endpoint that
isn't up yet just alarms immediately for a reason that isn't a real
problem.

## Which target type

- **`domain`**: checks what real users actually hit — the right choice
  whenever a domain exists (either path, EC2 or static-site). Reuses the
  same `ResourcePath` `validate_service.sh` already checks, so there's one
  source of truth for "is this app healthy," not two health-check
  definitions that could drift apart.
- **`ip`**: for an EC2-hosted app with no domain yet — checks the Elastic
  IP directly. Requires `AssignElasticIp=true` on `ec2-instance.yaml` —
  checking the dynamic subnet-assigned IP would silently start monitoring
  the wrong address the moment the instance stops/starts, since the
  health check's target is pinned at creation time. Not applicable to the
  static-site path (CloudFront has no stable IP to check — a domain, or
  the `*.cloudfront.net` default domain, is required there).

## 10s vs 30s interval

Route53 calls a 10-second interval "fast" and it costs meaningfully more
than the 30-second "standard" interval — default to 30s unless the user
specifically wants faster failure detection and has seen the cost
difference (`references/cost-estimates.md`). `FailureThreshold=3`
(default) means 3 consecutive failed checks before it's considered down —
avoids paging on one transient blip.

## Wiring to notifications

Same SNS topic as everything else (`references/notifications.md`) — pass
its ARN as `NotificationTopicArn`. If notifications weren't set up, the
alarm still exists and is visible in the CloudWatch console, just without
an action.
