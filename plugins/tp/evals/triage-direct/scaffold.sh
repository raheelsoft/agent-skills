#!/bin/sh
# the project this case runs in: scenario "picked-up" of evals/lib/bed.mjs, plus what makes DEMO-4 a direct fix: a sibling handler that already reads a query
# parameter, so there is a pattern to follow (the bare bed has none, and the rubric rates a change with no precedent as work that needs a plan)
set -e
node "$(dirname "$0")/../lib/bed.mjs" picked-up
wt=.claude/worktrees/DEMO-4/api
printf '%s\n' "import { contacts } from './list.js';" \
  "export function byEmail(req = {}) {" \
  "  const email = String(req.query?.email ?? '').trim().toLowerCase();" \
  "  return { status: 200, body: email ? contacts.filter((c) => c.email.toLowerCase() === email) : [] };" \
  "}" > "$wt/src/handlers/by-email.js"
git -C "$wt" add src/handlers/by-email.js
git -C "$wt" -c user.name=tp-eval -c user.email=tp-eval@example.test commit -q -m "add the by-email handler"
