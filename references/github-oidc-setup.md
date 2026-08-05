# GitHub Actions OIDC — notes and edge cases

`templates/cfn/github-oidc-role.yaml` trusts GitHub's OIDC provider
(`token.actions.githubusercontent.com`) with a `sub` claim condition scoped
to one repo + branch. Two things worth knowing before assuming a trust
failure means the template is wrong:

## The provider is per-account, not per-app

Only one `AWS::IAM::OIDCProvider` for `token.actions.githubusercontent.com`
can exist per AWS account — creating a second one for the same URL fails.
Before deploying `github-oidc-role.yaml` for a second app in an account that
already has one, check first:

```bash
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn" \
  --output text
```

If one exists, deploy the template with `CreateOidcProvider=false` and
`ExistingOidcProviderArn=<that arn>`.

## Renamed repo/owner breaks the plain `sub` pattern

GitHub's OIDC token's `sub` claim is normally
`repo:<owner>/<repo>:ref:refs/heads/<branch>`. If the repository **or its
owner org** has ever been renamed, GitHub instead emits an immutable-ID
suffixed form: `repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:refs/heads/<branch>`.

The template's `StringLike` condition only matches the plain form. If a
workflow run gets a generic `AccessDenied`/`Not authorized to perform
sts:AssumeRoleWithWebIdentity` error despite everything else looking
correct, this is the first thing to check — pull the actual `sub` claim
from the failed run (GitHub Actions logs it in the OIDC token debug output,
or check CloudTrail's `AssumeRoleWithWebIdentity` event for the rejected
`sub`) and compare.

Fix: broaden the `StringLike` condition to match both forms, e.g.
`repo:*<owner>*/<repo>*:ref:refs/heads/<branch>` — or simplest, add a second
literal pattern for the exact `@id` form once you know the real IDs. Prefer
the narrowest condition that actually matches over a broad wildcard.
