# S3 bucket(s) — access key handling

`templates/cfn/s3-bucket.yaml` deliberately does **not** create an
`AWS::IAM::AccessKey` resource. CloudFormation Outputs have no way to mask a
value the way parameter `NoEcho` does — anything in Outputs is returned in
plaintext by `aws cloudformation describe-stacks` forever, to anyone with
read access to the stack. Minting the access key outside the stack, right
after it's created, avoids putting a long-lived secret into stack state.

## After deploying the stack

```bash
aws iam create-access-key --user-name <app-name>-s3-user
```

This returns `AccessKeyId` and `SecretAccessKey` exactly once, in that
command's own output — nowhere else. Capture both immediately:

- Give them to the user as the `.env` values they asked for
  (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, plus the bucket name(s)
  from the stack's `PrivateBucketName`/`PublicBucketName` outputs).
- Fold them into the env content going to Step 9 — they become their own
  individually-named parameters there
  (`/{app-name}/prod/AWS_ACCESS_KEY_ID`, `/{app-name}/prod/AWS_SECRET_ACCESS_KEY`,
  etc. — see `references/env-parameter-store.md`), no separate S3-only
  record needed.
- Never print `SecretAccessKey` a second time anywhere else in the
  conversation or in any log-producing command after this point.

## Bucket visibility choice, and what it changes in app code

- **private**: Block Public Access on. Uploads/downloads happen through
  presigned URLs the app generates server-side — the app's own code needs
  `s3:PutObject`/`s3:GetObject` presigning logic; there is no public URL
  that works without a signature.
- **public**: reads are public (anyone can `GET` an object URL directly);
  writes still require the app's IAM credentials — nothing anonymous can
  upload.
- **both**: one bucket of each, e.g. a public bucket for served images/CSS
  and a private bucket for user-uploaded files that must stay access
  -controlled.

If the target repo already has S3 upload code, check it for a hardcoded
`ACL: 'public-read'` (or equivalent) on `PutObject` calls before wiring a
**private** bucket to it — that call will fail outright against a
Block-Public-Access bucket (this exact gap was hit and left for the app
team to fix in the original discovery-town build). Flag it to the user
rather than silently patching application code.
