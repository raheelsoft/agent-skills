# Docker-on-EC2 option

An alternative to bare pm2 for apps that already deploy via a Dockerfile
(and, usually, a `docker-compose.yml`). This is still a single EC2 instance
running `docker compose` — **not** a migration to ECS/Fargate. That's a
meaningfully different infrastructure model (no EC2, no pm2, no nginx
reverse-proxying to a local port the same way) and is intentionally out of
scope for this skill; treat it as a separate follow-up if the app outgrows
a single box.

## When to offer this path

Only if the target repo already has a working `Dockerfile`/
`docker-compose.yml` — don't scaffold one blindly into someone's repo. If
they want Docker but don't have one yet, that's an application-level change
for them (or a separate, explicit task), not something to invent as a side
effect of infra setup.

## What changes vs the pm2 path

- `EnableDocker=true` on `templates/cfn/ec2-instance.yaml` installs
  `docker.io` + the Compose plugin during bootstrap and adds the OS user to
  the `docker` group.
- Render `after_install.docker.sh.tmpl` and `application_start.docker.sh.tmpl`
  instead of the pm2 variants — `before_install.sh` and `validate_service.sh`
  are unchanged (validate_service just curls `127.0.0.1:<port>`, same as
  always).
- `ecosystem.config.js` isn't used at all in this path — skip rendering it.
- `COMPOSE_PROJECT_NAME` is pinned to the app name (not derived from the
  release directory, which changes every deploy) so `docker compose up -d`
  recreates the same container set in place instead of leaving the previous
  release's containers running alongside a new, differently-named set.

## Requirement: bind to `127.0.0.1:<port>`, not `0.0.0.0`

The app's container must publish its port to `127.0.0.1:<port>` (a
`ports: ["127.0.0.1:<port>:<port>"]` mapping in `docker-compose.yml`), the
same way the pm2 path listens only on localhost — nginx is still the only
thing that should be reachable from outside the box.

## Rollback

No changes needed — `/usr/local/bin/app-pipeline-rollback.sh` relinks
`current` to the previous release and re-runs `application_start.sh` from
there, which for the Docker path re-runs `docker compose up -d --build`
against the old release's `Dockerfile`/compose file, rebuilding back to the
previous image.
