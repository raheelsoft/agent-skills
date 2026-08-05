# Restricting a path with HTTP Basic Auth

Some paths need to exist but not be public — the most common case is a
backend's API docs (Swagger/OpenAPI UI, e.g. `/api/docs`) left open on
dev/staging for convenience but gated on prod. This is a small, optional
addition to Step 11's nginx setup, not a separate flow.

## When to ask

Part of Step 2b's operational batch — ask once per app (or once for the
whole combined-host setup, if `templates/app/nginx-combined.conf.tmpl` is
in play): "Restrict any path behind HTTP Basic Auth? (e.g. `/api/docs` on
prod, left public on dev/staging)." Skip if no. If yes: get the path(s)
and a username (default `admin`) — **not** the password. The password
follows Step 9's existing secrets flow (see below), never typed directly
into this question.

## Mechanism

`apache2-utils` (provides `htpasswd`) is installed unconditionally by
`templates/cfn/ec2-instance.yaml`'s bootstrap — cheap, and means this can
be turned on later without a stack update. Nothing else is provisioned
until a restricted path is actually requested.

1. **Password lives in Parameter Store, like every other secret** (see
   `references/env-parameter-store.md`) — add
   `/{app-name}/{environment}/DOCS_BASIC_AUTH_PASSWORD` to Step 9's list of
   parameters to write (same "paste now" vs "user creates later" choice as
   every other var; this one just happens to gate nginx, not the app
   itself, so it never appears in `.env`).

2. **Generate `/etc/nginx/{app-name}.htpasswd` on the box**, as part of
   Step 11 (same SSM round-trip that pushes the nginx config), via
   `--cli-input-json` (not hand-quoted `--parameters`, same reasoning as
   `references/deploy-key-setup.md` and `references/gotchas.md`'s quoting
   warning):
   ```json
   {
     "InstanceIds": ["<id>"],
     "DocumentName": "AWS-RunShellScript",
     "Parameters": {
       "commands": [
         "PASSWORD=$(aws ssm get-parameter --region <region> --name /<app-name>/<environment>/DOCS_BASIC_AUTH_PASSWORD --with-decryption --query Parameter.Value --output text)",
         "htpasswd -cb /etc/nginx/<app-name>.htpasswd <username> \"$PASSWORD\"",
         "unset PASSWORD"
       ]
     }
   }
   ```
   The password only ever exists in the remote shell's memory during this
   one command — never echoed, never written anywhere but the htpasswd
   file itself (which stores a hash, not the plaintext).

3. **Render the location block** and substitute it into
   `___RESTRICTED_LOCATION_BLOCK___` (present as an empty-string default in
   both `templates/app/nginx.conf.tmpl` and
   `templates/app/nginx-combined.conf.tmpl`):
   ```
       location <path> {
           auth_basic "Restricted";
           auth_basic_user_file /etc/nginx/<app-name>.htpasswd;
           proxy_pass http://127.0.0.1:<port>;
           proxy_set_header Host $host;
       }
   ```
   Use the backend's port for a docs-style path even on the combined-host
   template, where the general `___API_PREFIX___` location also points at
   the backend — the restricted block just needs to come first in the file
   for readability (ordering doesn't affect matching, nginx already picks
   the longest prefix).

## Per-environment, not global

Answer the Step 2b question **per environment**, not once for the whole
app — the common case is exactly "public on dev, restricted on prod," so
expect a "no" answer when setting up dev/staging and a "yes" when setting
up prod for the same app. Don't infer one environment's answer from
another's.

## Rotating the password

Update the parameter (`put-parameter --overwrite`), then re-run step 2
above (the htpasswd regeneration) over SSM — this is independent of a
regular app deploy, since nginx config isn't part of
`app-pipeline-deploy.sh`'s release cycle. `systemctl reload nginx` isn't
even required — `auth_basic_user_file` is read per-request, not cached at
config-load time.
