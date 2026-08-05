# Tearing down what this skill created

Nothing in SKILL.md's main flow deletes anything — this is deliberately a
one-way (creation) tool. If a user asks to decommission an app, follow
this order; getting it wrong just means a failed `delete-stack` and a
retry, not data loss, but doing it right the first time avoids the
confusion of a stack stuck in `DELETE_FAILED`.

## Order matters

1. **Pipeline/CI stacks first** — `<app-name>-pipeline` (or
   `github-oidc-role.yaml`/`github-oidc-role-static.yaml`) and
   `<app-name>-static-site-pipeline` if applicable. Nothing else depends on
   these; delete freely.
2. **S3 buckets — empty before deleting.** CloudFormation will not delete a
   non-empty bucket; `delete-stack` will fail (or hang, depending on
   `DeletionPolicy`) if `<app-name>-s3` or `<app-name>-site` stacks have
   objects in them. Empty first:
   ```bash
   aws s3 rm s3://<bucket-name> --recursive
   ```
   If the bucket is versioned (`s3-bucket.yaml`'s private bucket is),
   `s3 rm --recursive` isn't enough — it leaves old versions/delete markers
   behind, which also blocks stack deletion. Use
   `aws s3api delete-objects` with all versions listed, or the simpler
   (if slower) approach: script a loop over `list-object-versions` deleting
   every `VersionId`, or use a lifecycle rule that auto-expires everything
   first and wait for it to run.
3. **RDS — check `DeletionProtection` first.** If it's `true` (the
   default), `delete-stack` fails outright. Either update the stack with
   `DeletionProtection=false` first, or delete the DB instance directly
   with `--skip-final-snapshot` explicitly declined/accepted per the
   user's wishes — **ask which** (skip a final snapshot only with explicit
   confirmation; it's the last chance to recover the data). The template's
   `DeletionPolicy: Snapshot` means a normal stack deletion snapshots
   automatically unless you override it — a safe default, but confirm
   the user actually wants a snapshot kept (and knows it costs storage
   until manually deleted) rather than assuming.
4. **EC2 instance stack** — deleting `<app-name>-instance` releases the
   Elastic IP too, if one was assigned (it's in the same stack) — mention
   this: any DNS record still pointing at that IP goes stale immediately.
5. **DNS records / hosted zone last** — delete the `dns-record.yaml`
   stack(s), then `hosted-zone.yaml` only if this was the last app using
   that zone (a hosted zone can serve multiple apps' records) and the user
   is done with Route53 for this domain entirely — deleting a zone whose
   nameservers are still set at the registrar breaks the domain until
   they're changed back.
6. **Database backup bucket (`<app-name>-db-backup`) — ask first, don't
   assume it should go too.** Unlike the app's own S3/site buckets, this
   one's whole purpose is disaster recovery — the user may genuinely want
   the existing backups kept for a while after the app itself is
   decommissioned (e.g. compliance, or just wanting a final safety net
   during the transition). Ask explicitly rather than deleting it as a
   matter of course alongside everything else. If they do want it gone,
   same non-empty-bucket emptying step as #2 applies.
7. **Notifications last of all**, or whenever — nothing depends on the SNS
   topic existing.

## Confirm before any of this

Deletion is the most destructive action this skill's ecosystem can take —
the same Step 3 confirmation-gate discipline applies here, not loosened
just because it's "just cleanup." List exactly what's being deleted, note
which S3 buckets need emptying first (and that emptying is itself
irreversible), and whether the RDS instance will be snapshotted or fully
destroyed, before running anything.
