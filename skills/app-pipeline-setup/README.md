# app-pipeline-setup

A [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that provisions AWS infrastructure and a CI/CD pipeline for a Node.js app — a NestJS/Express-style backend, or any Node-servable frontend (Next.js, Nuxt, SvelteKit, Remix, a custom server) — and deploys it to an EC2 instance.

Point Claude Code at a repo and say "set up a pipeline for this app," "deploy this to AWS," or "bootstrap infra for this project," and it interviews you for the details it needs, shows you the exact list of AWS resources it's about to create (and a rough monthly cost) before creating anything, then provisions and wires up the pipeline end to end.

## What it sets up

- **CI**: AWS CodePipeline or GitHub Actions (OIDC — no long-lived AWS keys in GitHub), your choice
- **Deploy mechanism**: SSM RunCommand instead of the CodeDeploy agent (the agent's legacy installer rejects the Ruby version modern Ubuntu ships with — see `references/gotchas.md`), driving an atomic release/rollback model: each deploy lands in its own `releases/<sha>/` directory, gets validated by an actual health check, and only then gets symlinked live — a failed validation rolls back automatically
- **Zero-downtime restarts** via pm2 cluster mode, on by default for both frontend and backend (asked explicitly, not assumed — not every backend is safe to run as more than one process, see `references/zero-downtime-restarts.md`)
- **Private repos**: a per-app SSH deploy key, generated on the box, read-only, never transmitted anywhere (`references/deploy-key-setup.md`)
- **Monorepo support**: point it at a subdirectory instead of assuming the app is at repo root
- **Secrets**: every env var lives in SSM Parameter Store as its own named, encrypted parameter — never a single opaque blob, never committed, never printed (`references/env-parameter-store.md`)
- **Database**: none, local Postgres/Redis on the box, managed RDS, or bring-your-own connection string — with optional scheduled, encrypted, auto-expiring Postgres backups that are actually proven restorable before they're ever scheduled (`references/db-backups.md`)
- **HTTP Basic Auth** gating on any path (e.g. API docs public on dev, restricted on prod — `references/basic-auth-gating.md`)
- **Combined-host routing**: a frontend+backend pair can share one EC2 instance and one domain via path-based nginx routing — the cheapest two-app shape (`templates/app/nginx-combined.conf.tmpl`)
- **DNS + TLS**: automatic Route53 record creation (or a records-to-add report for GoDaddy/Cloudflare/Namecheap/other external providers), certbot for HTTPS
- **A static-export alternative**: for a frontend that doesn't actually need a server, an S3+CloudFront path instead of EC2
- **S3 buckets, CloudWatch alarms, SNS notifications, continuous uptime monitoring, a staging environment** — all optional, all asked about explicitly
- **A local-dev env report** for developers who need real credentials to run the app on their own machine
- **Teardown guidance** for decommissioning everything it created

See `SKILL.md` for the full step-by-step flow, and `references/` for the reasoning and exact commands behind each piece.

## Security posture

- No inbound SSH by default — administration goes through SSM Session Manager; opening port 22 is an explicit, non-default choice
- Least-privilege IAM throughout — every policy is scoped to specific resource ARNs, not wildcards, and the GitHub OIDC trust policy is scoped to one repo + branch
- Secrets never pass through chat, tool output, or command logs unredacted — Parameter Store is the source of truth, fetched fresh on every deploy
- A pre-flight check catches an `AppName` that collides with an existing, unrelated stack before anything gets created or accidentally updated

## Cost awareness

Every confirmation gate includes a rough monthly cost estimate before anything is created (see `references/cost-estimates.md`) — no NAT Gateway, no ALB/blue-green by default, and a combined-host option for a frontend+backend pair that would otherwise need two separate domains and certs.

## Installing

```bash
npx @raheelsoft/agent-skills install app-pipeline-setup
```

This copies this directory into `~/.claude/skills/app-pipeline-setup/`, which is where Claude Code discovers skills automatically. See the [repo root README](../../README.md) for the other install commands (list, install all, custom target directory).

To install without `npx`, clone the repo and copy just this subdirectory:

```bash
git clone git@github.com:raheelsoft/agent-skills.git /tmp/agent-skills
cp -r /tmp/agent-skills/skills/app-pipeline-setup ~/.claude/skills/app-pipeline-setup
```

## Requirements

- `aws configure` already run with credentials for the target AWS account
- `git`, and `gh` if you want GitHub Actions autodetection to work smoothly
- An existing GitHub repo for the app being deployed

## Repo layout

```
SKILL.md                    Entry point — the full interview + provisioning flow
references/                 One doc per concern: reasoning, exact commands, gotchas already hit
templates/cfn/               CloudFormation templates (one per AWS resource group)
templates/app/               Files rendered into the target app's repo (buildspec, nginx, pm2, hook scripts)
templates/github-actions/    GitHub Actions workflow templates
scripts/render.sh            The placeholder-substitution engine every template goes through
```

## Status

Currently used as a Claude Code skill. Packaging this as a standalone `npx` CLI (usable outside Claude Code) is planned but not yet done.
