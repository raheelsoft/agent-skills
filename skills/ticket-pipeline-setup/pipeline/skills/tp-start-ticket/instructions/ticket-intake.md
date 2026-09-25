# Ticket Intake

## Reading the snapshot

From the fetched ticket (SKILL.md step 2), pull out:

- **Title** — drives the repo target and the branch slug.
- **Status** — the tracker's state and its category (not started / in progress / in
  review / done / cancelled). State names differ per tracker; the steps key on the
  category.
- **Assignee** — empty means unassigned.
- **Labels** — sprint/iteration and area labels. Informational here; they matter for
  planning, not for the pickup itself.
- **Relations** — blocked-by / blocks. Feed the blocked check.
- **Description** — often carries an implementation brief (files to read first, the
  pattern to extend, acceptance criteria). Record its pointers in `ticket.md` (SKILL.md
  step 9) — `/tp-triage` and `/tp-plan` start from them.
- **Attachments / linked PRs** — the fastest way to see whether work on this ticket
  (or on a blocker) already exists.

## Repo target

The candidate repos are the git checkouts at or under the session's working directory
— one repo, or a folder holding several (frontend, backend, mobile, …). Work out which
one(s) the ticket touches from, in order:

1. A title convention, if the project has one (a prefix such as `FE:`/`BE:`, a
   bracketed component `[api]`, a component field). Read it from existing tickets or
   the conventions file; don't invent one.
2. Area labels or the brief's file paths.
3. Otherwise ask — especially for epic-level tickets, whose own ticket is usually a
   container while the real work sits in sub-issues (list the ticket's children to
   check before picking it up directly).

A ticket that spans repos gets one branch per repo (and later one PR per repo — a PR
can't span repos).

## Status vs reality

Ticket status lags the code. Before treating an "in review" ticket or blocker as
unfinished, check whether its PRs are already merged into the base branch — the PR's
state via the hosting platform's CLI/API, or `git log <remote>/<base> --grep='<PR number
or branch>'` where the merge strategy records it. PR links come from the ticket's
attachments and comments. Merged means the work exists and only the status is stale —
report it as such rather than re-doing or re-blocking on it. Merged into the base is
not the same as released or promoted to a client-facing branch, if the project has one;
keep the two apart in the report.

## Branch slug

Derive the branch name from the repo's **own** convention — read `git log`/`git branch
-r` for the pattern in use (`feat/<slug>`, `fix/<slug>`, `<user>/<key>-<slug>`, …) and
follow it exactly, including whether the ticket key is embedded. Some trackers suggest
a branch name on the ticket; use it only if it matches the repo's actual convention.

- Strip any title prefix / module bracket, lowercase, hyphenate, keep roughly 5–8
  meaningful words.
- Type (`feat` vs `fix`, if the convention has one) follows what the ticket actually
  describes — new behaviour vs correcting broken behaviour; a ticket the tracker
  classifies as a defect is `fix`, anything else `feat` — never a stop for this.

## Picking the next ticket

When asked to "pick the next one", filter the project's open tickets by the priority
order the conventions file or the person's standing instructions define, stop at the
first non-empty tier, then run the normal steps on the pick. Where neither defines an
order, this is the default:

1. **Open defects from the previous iteration** — broken existing behaviour outranks
   change requests and new features. Classify by whether existing behaviour is broken,
   not by the ticket's wording; a "fix" that describes a new requirement is a feature.
2. **Unblocked, unstarted tickets in the current iteration**, highest priority first.
   "Unblocked" per `blocked-check.md`, including its soft-block nuance.
3. **Tickets that need a decision, not code** (client input, vendor choice, open scope)
   — list them for the user instead of starting one.

Respect any scope given as an argument or standing instruction (e.g. "backend only" —
pick backend tickets, and do only the backend half of a cross-repo one). When a tier
leaves more than one plausible pick, return the shortlist with one line of reasoning
each as the report and change nothing; the re-run with `answers=<id>` (or `/tp-start-ticket
<id>`) takes that one.

**Several at once** (`count=<n>`): walk the tiers in order and take picks until n are
found — each unblocked (`blocked-check.md`), none depending on another pick or on
anything still open (a blocked-by relation, a stated dependency, a stacked sibling
still in review), none already in flight — so they can run in parallel without
waiting on each other; a tier with more plausible picks than places left is taken in
priority order, ties by id. Return them as `picks: <ids>` with one line each; with
fewer than n found, say why the rest were passed over. `pick=true` stops there: the
caller (`/tp-run-ticket next count=<n>`) starts one pickup per id.
