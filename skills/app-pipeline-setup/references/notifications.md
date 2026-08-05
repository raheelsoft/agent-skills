# Notifications

`templates/cfn/notifications.yaml` creates one SNS topic + email
subscription per app, used as:

- The `AlarmActions` target for `ec2-instance.yaml`'s disk-space and
  EC2-status-check CloudWatch alarms.
- (CodePipeline path) A `AWS::CodeStarNotifications::NotificationRule` in
  `pipeline.yaml`, firing on any `FAILED` pipeline execution.
- (GitHub Actions path) An `aws sns publish` step at the end of
  `templates/github-actions/deploy.yml.tmpl`, gated on `if: failure()`.

## Deploy order

Deploy `notifications.yaml` before (or alongside) `ec2-instance.yaml` and
`pipeline.yaml`/the GitHub Actions role stack if you want the topic ARN
wired in from the start — pass its `TopicArn` output as those templates'
`NotificationTopicArn` parameter. If notifications are added later, both
`ec2-instance.yaml` and `pipeline.yaml` can be redeployed (via `aws
cloudformation deploy` with the same stack name) with the parameter added —
CloudFormation updates the alarm actions / notification rule in place, no
resource replacement.

## Email confirmation

SNS email subscriptions require a one-time confirmation click sent to the
address given — nothing is delivered until that's clicked. Tell the user
this explicitly; a silent "notifications are set up" without this caveat
means their first real failure goes unnoticed.

## Skipping notifications

Leaving `NotificationTopicArn` blank (the default on every template that
accepts it) is a fully supported, complete configuration — alarms/rules are
still created, just without an action attached (still visible in the
CloudWatch/CodePipeline console). Don't treat "no notification email given"
as a reason to skip creating the alarms themselves.
