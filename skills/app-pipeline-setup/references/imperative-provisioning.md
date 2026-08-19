# Imperative provisioning — matching an account's existing hand-built infra

Only reached after Step 2a-pre2's explicit question fires and the user
picks it — never inferred, never a silent fallback. This is not a second
full set of templates mirroring the 14 CloudFormation ones; it's a
method — discover the existing pattern, replicate its exact shape under
the new name, via plain AWS CLI calls.

## The method: discover, then replicate

1. **Find a sibling resource of the same kind that already works.** If
   this account already runs a CodeBuild project for another
   environment/app, that's the pattern to match — not a generic "how
   CodeBuild projects are usually set up" assumption:
   ```bash
   aws codebuild batch-get-projects --names <existing-project-name>
   aws deploy get-application --application-name <existing-app-name>
   aws deploy get-deployment-group --application-name <existing-app-name> --deployment-group-name <existing-dg-name>
   aws iam get-role --role-name <existing-role-name>
   aws iam list-attached-role-policies --role-name <existing-role-name>
   ```
   These are read-only — pure inspection, never modifies the sibling
   resource being used as a reference.
2. **Read the actual config, not just the resource type.** The buildspec
   phases it runs, the deployment group's exact tag-based instance
   selector, the IAM role's exact trust policy and attached policies, the
   nginx `server_name`/proxy_pass shape, the certbot renewal setup — the
   goal is a new resource indistinguishable in *shape* from its sibling,
   not just "also a CodeBuild project."
3. **Replicate under the new name, via direct `create-*`/`put-*` calls** —
   `aws codebuild create-project`, `aws deploy create-application` +
   `create-deployment-group`, `aws iam create-role` + `attach-role-policy`,
   plain SSM/SSH commands for the nginx config and certbot run — same
   shape as step 2, new name, nothing else different.

## Guardrails — this path doesn't relax anything Step 3 already requires

- **The confirmation gate still applies exactly as written.** Before
  creating anything, list every resource about to be created via CLI —
  same bar as the CFN manifest (exact names, IAM policies, security group
  rules, cost estimate) — and wait for an explicit yes. Choosing this path
  over CloudFormation is not a way to create resources with less
  visibility than the CFN path would have given.
- **Never touch the existing sibling resource** being used as the
  reference pattern — read-only inspection only, as in step 1 above. This
  path adds a new resource that looks like its sibling; it does not modify
  the sibling itself under any circumstance.
- **Record what actually got created — there is no CloudFormation stack to
  ask later.** This is the real, permanent cost of this path, not a
  footnote: the CFN path gets `aws cloudformation describe-stacks` /
  `get-template` for free, as the durable source of truth for "what exists
  and how was it configured" (see `references/server-bootstrap.md` and the
  earlier CloudFormation-state discussion this skill's design draws on).
  The imperative path has no equivalent — nothing tracks these resources
  as a group unless it's written down. Generate the same
  `docs/PIPELINE-ARCHITECTURE.md`/`docs/PIPELINE-OPERATIONS.md` pair Step
  14 already produces for the CFN path, and additionally record the exact
  `create-*` calls actually run (resource type, name, and the key
  parameters/policies used) — this is the only recovery record that will
  ever exist for this piece.
- **Teardown has to be manual and symmetric.** `references/teardown.md`'s
  guidance assumes CloudFormation stacks to delete; there is no
  `aws cloudformation delete-stack` equivalent here. Decommissioning this
  piece later means working from the recorded resource list above and
  issuing the matching `delete-*`/`detach-role-policy`/etc. calls by hand,
  one at a time, in reverse dependency order. Mention this plainly as part
  of Step 2a-pre2's question — it's a real, ongoing cost of choosing this
  path, not just an upfront one, and the user should know it before
  picking this over CloudFormation.
