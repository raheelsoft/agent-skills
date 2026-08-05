# CodeStar Connection — one-time manual step

`templates/cfn/pipeline.yaml` needs an already-**Available** CodeStar
Connection ARN. This cannot be created fully headlessly — the GitHub App
OAuth authorization step requires a human click in a browser. There is no
way around this; do not attempt to script past it.

## Check for a reusable connection first

A CodeStar Connection is scoped to a GitHub org, not a single repo — if one
already exists and is `Available` for the same `GitHubOwner`, reuse its ARN
instead of creating a new one:

```bash
aws codestar-connections list-connections --region <region> \
  --query 'Connections[?ConnectionStatus==`Available`].{Name:ConnectionName,Arn:ConnectionArn,Owner:OwnerAccountId}' \
  --output table
```

## Creating a new one

```bash
aws codestar-connections create-connection --region <region> \
  --provider-type GitHub \
  --connection-name <app-name>-github
```

This returns a connection in `PENDING` status. Tell the user:

1. Open the AWS Console → Developer Tools → Settings → Connections.
2. Find the new connection (status `Pending`), click **Update pending
   connection**.
3. Authorize (or reuse an existing authorization of) the GitHub App for the
   target org/repo.
4. Status flips to `Available`.

Poll until it flips:

```bash
aws codestar-connections get-connection --region <region> \
  --connection-arn <arn> --query 'Connection.ConnectionStatus' --output text
```

Do not proceed to deploy `pipeline.yaml` until this reads `Available` — the
stack will create fine but the pipeline's Source stage will fail forever
against a `Pending` connection.
