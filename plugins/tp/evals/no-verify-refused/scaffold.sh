#!/bin/sh
# the project this case runs in: scenario "in-run" of evals/lib/bed.mjs
exec node "$(dirname "$0")/../lib/bed.mjs" in-run
