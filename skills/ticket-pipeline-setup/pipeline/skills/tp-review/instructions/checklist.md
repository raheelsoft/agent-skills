# Review Checklist

Check each item against the diff. Flag only what you can point to in the changed
code. Skip sections that don't apply to this project or this change.

## Security & access control
- [ ] New/changed routes enforce the project's authentication and authorization, or
      are explicitly and intentionally public
- [ ] Access decisions use the project's permission/capability mechanism, not
      hardcoded role or type strings
- [ ] No secrets, keys, tokens, or credentials in code
- [ ] Input validated at trust boundaries (user input, external responses) before it
      reaches a query, a command, or rendered markup

## Correctness & data integrity
- [ ] State transitions go through the project's validation and audit/history path,
      not a raw write that skips derived-state updates
- [ ] Mutations that must be visible elsewhere (cache invalidation, realtime sync,
      subscriptions) actually trigger that propagation
- [ ] Queries that can grow are bounded or paginated
- [ ] Constants, enums, and thresholds are imported from their owning module, not
      re-declared where they can drift
- [ ] Edge cases handled: null/absent, empty, zero, negative

## Types & error handling
- [ ] No untyped escape hatches (`any`-equivalents, blanket casts, suppression
      comments) without a stated reason
- [ ] Optional/nullable values handled as such, not force-unwrapped
- [ ] Failures are surfaced or logged, never silently swallowed
- [ ] Acquired resources (connections, handles, subscriptions, listeners) are
      released on every exit path

## UI (when the change touches it)
- [ ] Checked against the project's design reference if one exists (mockup,
      prototype, design tool, an equivalent existing screen); name what was checked
      or state that none exists
- [ ] Layout, copy, and states match that reference — nothing invented, nothing
      visible silently dropped
- [ ] Colors and spacing go through the project's design tokens/theme, not raw values;
      no inline styles except genuinely data-driven ones
- [ ] Existing shared components reused rather than duplicated

## Hygiene
- [ ] No leftover debug output
- [ ] No real user PII in logs, comments, fixtures, or seed data
- [ ] No dead or commented-out code; no unused imports
- [ ] Units stay focused on one responsibility
- [ ] New behavior is covered by tests where the project's conventions expect it
- [ ] Comments and PR text assert nothing about code outside the diff that the change
      does not prove — no counts, no "the only caller", no specificity or precedence
      arithmetic, unless verified in this pass (README § Verification rules)

## Skepticism pass
When the first pass found nothing, assume something was missed and re-read for:
- A new or changed endpoint/route with no authentication/authorization, or one that
  is public and shouldn't be
- Authorization decided by a hardcoded role/type string instead of the project's
  permission or capability check
- A state transition that bypasses the validation, derived-state update, or
  audit/history write the project normally routes it through
- A write that reaches around the API/service layer it is supposed to go through
- A hardcoded secret or credential; real user PII in a log line, comment, fixture, or
  seed
- An unbounded query on a path that can grow (search, listing, dashboard, export)
- Missing validation at a trust boundary; injection via string-built queries,
  commands, or unescaped markup
- A failure that is swallowed instead of surfaced or logged
- A resource acquired but not released on every exit path
- Shared mutable state touched from more than one async path without ordering
- A constant re-declared locally instead of imported from where it is defined
- UI that diverges from the project's design reference or duplicates an existing
  component, or a loading state that can flash a wrong result before data resolves
- A comment or description asserting something about the wider codebase — a count, "the
  only", "every", a specificity or precedence calculation — that is stale or was never
  true; verify it or have it cut, and re-derive rather than trusting a prior round's
  figure
- A selector, override or lookup whose precedence is assumed rather than computed, where
  a type selector, `!important`, layer or source order decides it
