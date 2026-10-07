# release.json — good and bad

Written by `/tp:release` with `node <lib>/state.mjs put <workdir> release` (`release.<repo>` on a cross-repo ticket).
`run` is the deploy run that was watched (`null` when nothing deployed), `follow-ups` the documented operator steps it ran,
`smoke` the checks it made where the change runs, `promoted` set only when it was asked to promote.

## Good

```json good release
{
  "repo": "shop-web", "sameAs": null,
  "run": { "id": "run-1842", "status": "Succeeded", "revision": "c0ffee1" },
  "env": { "name": "staging", "url": "https://staging.shop.example.com" },
  "followUps": [{ "name": "invalidate the CDN cache", "status": "done", "note": "ran the purge job; 200", "authority": "docs/deploy.md § After a release" }],
  "smoke": [{ "check": "GET /invoices/1 returns 200 and the total includes VAT", "result": "pass" }],
  "promoted": null
}
```

Shipped by a sibling ticket's deploy — this one has none of its own:

```json good release
{ "repo": "shop-web", "sameAs": "ACME-42", "run": null, "env": null, "followUps": [], "smoke": [], "promoted": null }
```

## Bad

A run with no status — `done` cannot be told from `still going`:

```json bad release $.run.status: required, missing
{ "repo": "shop-web", "sameAs": null, "run": { "id": "run-1842", "revision": "c0ffee1" }, "env": null, "followUps": [], "smoke": [], "promoted": null }
```

A smoke check with no result:

```json bad release $.smoke[0].result: required, missing
{ "repo": "shop-web", "sameAs": null, "run": null, "env": null, "followUps": [], "smoke": [{ "check": "GET /invoices/1" }], "promoted": null }
```

A follow-up list that is not there — accept reads it to know what was done:

```json bad release $.followUps: required, missing
{ "repo": "shop-web", "sameAs": null, "run": null, "env": null, "smoke": [], "promoted": null }
```
