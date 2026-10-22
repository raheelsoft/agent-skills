#!/bin/sh
# the project this case runs in: scenario "released" of evals/lib/bed.mjs
exec node "$(dirname "$0")/../lib/bed.mjs" released
