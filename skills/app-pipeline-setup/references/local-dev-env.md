# Local dev env report

At the end of a run, generate `templates/app/local-dev-env-report.md.tmpl`
into a file developers can use to run the app locally against the same
shared S3 bucket / database the deploy uses. This is a deliberate,
requested exception to the "never echo `.env` content" rule in
`references/gotchas.md` — that rule is about not *accidentally* leaking a
secret into a log or grep. This is a purposeful, one-time handoff of
credentials the user explicitly asked for, delivered as its own clearly
labeled file rather than pasted inline into chat.

## Where to write it

**Outside the target repo** — e.g. the scratchpad/session directory, not
anywhere under the app's git working tree. A file with real secrets sitting
in a repo directory is one `git add .` away from landing in history
forever. Name it something that can't be mistaken for a template or
example file, e.g. `LOCAL-DEV-SECRETS-<app-name>.md` — never `.env.example`
or similar (those conventionally hold placeholders, and a real-secrets file
with that name invites someone to commit it out of habit).

Deliver it to the user directly (e.g. via a file-send tool if available)
rather than printing the whole thing into the chat transcript, and remind
them it's theirs to pass along securely and delete once no longer needed.

## Building `___LOCAL_ENV_BLOCK___`

Concatenate, in this order:
1. The base env content from Step 9's parameters
   (`/{app-name}/prod/*` in Parameter Store — `references/env-parameter-store.md`
   has the read pattern, just reuse it), **with any value that shouldn't
   be shared across environments swapped for a local-safe one** — e.g.
   session/JWT secrets ideally differ per environment; if the user only
   gave you one set of secrets, use them but note in
   `___DB_LOCAL_NOTE___`/inline comments which values are being reused
   across prod and local rather than silently presenting it as if this was
   always the intended design.
2. S3 credentials from Step 6, if a bucket was created — these work
   unmodified from a laptop (see below).
3. A `DATABASE_URL` (or equivalent) reflecting how local dev actually
   reaches the database — see the RDS caveat below, this is **not** always
   just the same value stored in Parameter Store for the box.

## `___DB_LOCAL_NOTE___` — pick the one that applies

- **Local Postgres on the box (`NeedsPostgres=true`)**: "This app's data
  isn't shared with your local machine — run your own local Postgres for
  development; there's nothing to connect to remotely here."
- **Managed RDS**: RDS in this setup is **never publicly reachable**
  (`PubliclyAccessible: false`, security group scoped to the app instance
  only — see `references/rds-database.md`) — a raw `DATABASE_URL` pointing
  at the RDS endpoint will not connect from outside the VPC. Give
  developers one of:
  - Run their own local Postgres for day-to-day dev (simplest, recommended
    default — mention this first).
  - An SSM port-forwarding tunnel through the app instance, for when they
    specifically need to see real data:
    ```bash
    aws ssm start-session --target <instance-id> \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["5432"]}'
    ```
    then `DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/<dbname>`
    locally, only while the tunnel is running.
  - Do **not** suggest adding the developer's home/office IP to the RDS
    security group as a shortcut — it's the kind of one-off exception that
    accumulates and never gets cleaned up. If asked, explain the tunnel
    instead.
- **External/already-have-one database**: ask whoever manages it whether
  direct access from outside the VPC/network is allowed, and say so
  explicitly rather than guessing.

## `___S3_LOCAL_NOTE___`

S3 access works identically from a laptop as it does from the deploy box —
it's authenticated by IAM credentials, not network location. If a private
bucket was created, its CORS config already includes `http://localhost:3000`
by default (`AllowedOrigins` on `templates/cfn/s3-bucket.yaml`) specifically
so browser-based local dev can presign/PUT against it — note the actual
bucket name(s) and region here, and mention that if local dev runs on a
different port/origin, `AllowedOrigins` needs updating (redeploy the S3
stack) or presigned uploads will fail CORS in the browser console with no
obvious server-side error.
