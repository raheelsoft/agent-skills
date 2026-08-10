# agent-skills

A collection of [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills), installable via `npx`.

## Install a skill

```bash
npx @raheelsoft/agent-skills
```

Run with no arguments to interactively pick a skill (or install it directly if there's only one in the package). Or install by name:

```bash
npx @raheelsoft/agent-skills install app-pipeline-setup
```

Every skill gets copied into `~/.claude/skills/<name>/`, which is where Claude Code discovers skills automatically — nothing else to configure.

```
npx @raheelsoft/agent-skills list              List every skill in this package
npx @raheelsoft/agent-skills install <name>    Install one skill by name
npx @raheelsoft/agent-skills install --all     Install every skill in this package
npx @raheelsoft/agent-skills --dir <path>      Install into <path> instead of ~/.claude/skills
npx @raheelsoft/agent-skills --force           Overwrite an existing install without asking
npx @raheelsoft/agent-skills -y                Assume "yes" to any prompt (non-interactive)
```

## What's in here

| Skill | What it does |
|---|---|
| [`app-pipeline-setup`](skills/app-pipeline-setup/) | Provisions AWS infra and a CI/CD pipeline for a Node.js app (backend or frontend), deploying to EC2 via SSM RunCommand. Also does security audits and incident response on an existing instance (compromise/persistence checks, exposure checks, containment) — see its own [README](skills/app-pipeline-setup/README.md) for the full feature list. |

## Adding a skill to this repo

Each skill lives in its own directory under `skills/`, with a `SKILL.md` at its root (the file Claude Code reads to discover and describe it). The installer (`bin/cli.js`) auto-detects any directory under `skills/` that contains one — no registration step needed beyond adding the directory.

## Development

The installer has zero runtime dependencies (plain Node built-ins only, for a fast, dependency-free `npx` cold start). To test a change locally without publishing:

```bash
node bin/cli.js install app-pipeline-setup --dir /tmp/skills-test
```
