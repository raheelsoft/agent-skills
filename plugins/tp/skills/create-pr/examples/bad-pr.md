# Bad PR Examples (anti-patterns)

## Anti-pattern 1 — File listing

```markdown
## Description
- Added src/auth/ownership.ts
- Modified src/records/handlers.ts
- Modified src/records/service.ts
```

Why it's bad: the diff already shows this. Zero information added.

## Anti-pattern 2 — Code narration

```markdown
## Description
In the service I added a check that compares the request user's id against the
record's ownerId, then returned a forbidden error if they don't match, then updated the
handler to call the new check…
```

Why it's bad: this is the diff in prose. It says nothing about why the change exists
or how to tell it works.

## Anti-pattern 3 — Speculative risk

```markdown
## Risks
This might affect performance. There could be edge cases with concurrent edits. Some
users may see different behaviour.
```

Why it's bad: none of this was checked. Either verify a risk and state what you found,
or leave it out.

## Anti-pattern 4 — Missing problem

```markdown
## Summary
Implements ABC-118.
```

Why it's bad: a reviewer has to open the tracker to learn what the PR is for. The
problem statement belongs in the first line.
