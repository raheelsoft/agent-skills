# Private repo deploy key (SSH)

`app-pipeline-deploy.sh` (installed once per instance by
`templates/cfn/ec2-instance.yaml`) does its own independent `git fetch`/
`git reset --hard` on every deploy — this is true for **both** CI
mechanisms, not just one. AWS CodePipeline's CodeStar Connection only
authenticates that pipeline's own Source stage (which fetches into
CodePipeline's S3 artifact store and is never actually consumed by the
Deploy stage — see `references/gotchas.md`'s "Why SSM-triggered deploy
instead of real CodeDeploy" for the architecture this follows from); GitHub
Actions' OIDC role only grants `ssm:SendCommand`, nothing repo-related at
all. Neither CI path gives the box itself anything it can authenticate a
git clone with — for a private repo, that has to be set up explicitly,
once, per app, regardless of which CI mechanism was chosen in Step 2b.

## Why an SSH deploy key, not a PAT

A GitHub PAT is scoped to the *user* who created it (every repo they can
touch, unless a fine-grained token is deliberately scoped down further)
and needs manual rotation/expiry management. A deploy key is scoped to
exactly one repo, read-only by default (never check "Allow write access"
when adding it — this box only ever needs to read), and is generated
directly on the box so the private half never exists anywhere else — not
in chat, not in Parameter Store, not in any command output. Strictly less
blast radius if the instance is ever compromised, and nothing to rotate on
a schedule the way a PAT's expiry forces.

## One-time setup, per app

Ask first (`AskUserQuestion`) whether the app's repo is private — this is
a new-credential decision, the same weight as Step 3's confirmation gate.
Skip this whole doc for a public repo; the plain HTTPS clone in SKILL.md
Step 8 needs no credential at all.

For a private repo, run this **before** Step 8's initial clone:

```
aws ssm send-command --region <region> --instance-ids <id> \
  --document-name AWS-RunShellScript \
  --cli-input-json file:///tmp/deploy-key-params.json
```

where `/tmp/deploy-key-params.json` (built via `jq`, not hand-quoted — see
`references/gotchas.md`'s note on manual `--parameters` string quoting)
holds:

```json
{
  "InstanceIds": ["<id>"],
  "DocumentName": "AWS-RunShellScript",
  "Parameters": {
    "commands": [
      "sudo -u <os-user> mkdir -p <app-dir>/.ssh",
      "sudo -u <os-user> chmod 700 <app-dir>/.ssh",
      "sudo -u <os-user> test -f <app-dir>/.ssh/deploy_key || sudo -u <os-user> ssh-keygen -t ed25519 -N '' -f <app-dir>/.ssh/deploy_key -C '<app-name>-deploy-key'",
      "sudo -u <os-user> bash -c 'ssh-keyscan -t ed25519 github.com >> <app-dir>/.ssh/known_hosts 2>/dev/null'",
      "cat <app-dir>/.ssh/deploy_key.pub"
    ]
  }
}
```

Read the command's `StandardOutputContent` via
`aws ssm get-command-invocation` — the last line is the public key. Show
it to the user with:

> Add this as a **read-only** deploy key: the repo's GitHub page ->
> Settings -> Deploy keys -> Add deploy key. Paste the key, leave "Allow
> write access" unchecked, save.

Wait for explicit confirmation the key was added before running Step 8's
clone, using the SSH form of the repo URL
(`git@github.com:<owner>/<repo>.git`) instead of the HTTPS one:

```
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters commands="['sudo -u <os-user> mkdir -p <app-dir>/releases', 'sudo -u <os-user> bash -lc \"GIT_SSH_COMMAND=\\\"ssh -i <app-dir>/.ssh/deploy_key -o UserKnownHostsFile=<app-dir>/.ssh/known_hosts -o IdentitiesOnly=yes\\\" git clone --branch <branch> git@github.com:<owner>/<repo>.git <app-dir>/repo\"']"
```

From then on, `app-pipeline-deploy.sh` picks the key up automatically — it
checks for `<app-dir>/.ssh/deploy_key` and exports `GIT_SSH_COMMAND` only
when present, so a public-repo app on the same instance, or any app set up
before this mechanism existed, is completely unaffected.

## Per-app, not per-instance

Each app gets its own key pair under its own `<app-dir>/.ssh/` — never
share one key across apps, even on the same instance. GitHub deploy keys
are repo-scoped by design (unlike a PAT), so reusing one app's key for a
second app's repo would fail to authenticate anyway; generating a fresh
one per app is both the secure default and the only one that actually
works.

## Known-hosts pinning

`ssh-keyscan` fetches GitHub's current host key over an unauthenticated
connection — trust-on-first-use, not cryptographically verified against
GitHub's published fingerprints (this is what `git clone` itself does
interactively via `StrictHostKeyChecking=accept-new` otherwise, so it's
standard practice, not a shortcut unique to this skill). If the client's
security posture requires verified pinning, compare the scanned key in
`<app-dir>/.ssh/known_hosts` against
[GitHub's published SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
before the first clone runs, and note that this was done in Step 14's
pipeline architecture report.

## Rotating or revoking a key

Delete the deploy key from the repo's GitHub settings, then on the box:
`rm <app-dir>/.ssh/deploy_key*` and regenerate via the setup commands
above. The next deploy fails until the new key is added on GitHub —
expected, not a bug; treat it like any credential rotation (see
`references/gotchas.md`'s note on a forced reload surfacing an unrelated,
already-latent gap — the same "confirm health after, not just a clean
exit" discipline applies to a key rotation too).
