# pr.json — good and bad

Written by `/tp:create-pr` with `node <lib>/state.mjs put <workdir> pr` (`pr.<repo>` on a cross-repo ticket); `/tp:merge`
adds each review pass with `findings.mjs record` and the merge commit with `put … --merge`. `round` is the ticket's round
the PR belongs to; `reviews` is the loop's history; `merged` is the merge commit's sha, `null` until then.

## Good

A creation round — no review yet, nothing merged:

```json good pr
{ "repo": "shop-web", "url": "https://git.example.com/acme/shop-web/pull/218", "number": 218, "round": 1, "reviewRounds": 0, "reviews": [], "verdict": null, "merged": null }
```

After two review passes and the merge:

```json good pr
{
  "repo": "shop-web", "url": "https://git.example.com/acme/shop-web/pull/218", "number": 218, "round": 1, "reviewRounds": 2,
  "reviews": [
    { "round": 1, "sha": "3f9c2ab", "verdict": "BLOCK", "open": [1], "new": [1, 2] },
    { "round": 2, "sha": "a81d0e4", "verdict": "PASS WITH WARNINGS", "open": [], "new": [] }
  ],
  "verdict": "PASS WITH WARNINGS", "merged": "c0ffee1"
}
```

## Bad

The number is a number — the platform's CLI is asked for it by that value:

```json bad pr $.number: expected integer, got string
{ "repo": "shop-web", "url": "https://git.example.com/acme/shop-web/pull/218", "number": "218", "round": 1, "reviewRounds": 0, "reviews": [], "verdict": null, "merged": null }
```

Merged without a verdict — nothing says the review allowed it:

```json bad pr merged without a recorded verdict
{ "repo": "shop-web", "url": "https://git.example.com/acme/shop-web/pull/218", "number": 218, "round": 1, "reviewRounds": 0, "reviews": [], "verdict": null, "merged": "c0ffee1" }
```

A verdict the review never gives (`PASS`, `PASS WITH WARNINGS`, `BLOCK`):

```json bad pr $.verdict
{ "repo": "shop-web", "url": "https://git.example.com/acme/shop-web/pull/218", "number": 218, "round": 1, "reviewRounds": 1, "reviews": [{ "round": 1, "sha": "3f9c2ab", "verdict": "OK", "open": [], "new": [] }], "verdict": "OK", "merged": null }
```
