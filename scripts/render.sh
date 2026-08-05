#!/usr/bin/env bash
#
# Renders a .tmpl file by substituting ___PLACEHOLDER___ tokens with values.
# Uses bash string substitution rather than sed — sed is line-oriented and
# mangles a replacement value that contains embedded newlines (e.g. a whole
# .env block passed as one value for the local-dev-env-report template).
#
# Usage:
#   render.sh <template-file> <output-file> KEY1=value1 KEY2=value2 ...
#
# Each KEY becomes ___KEY___ in the template. Missing placeholders left over
# after substitution cause a hard failure — better than silently shipping a
# literal "___APP_NAME___" into a generated pipeline file.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <template-file> <output-file> KEY1=value1 [KEY2=value2 ...]" >&2
  exit 1
fi

TEMPLATE="$1"
OUTPUT="$2"
shift 2

content="$(cat "$TEMPLATE")"

for pair in "$@"; do
  key="${pair%%=*}"
  value="${pair#*=}"
  # ${var//pattern/replacement} — the pattern side is a shell glob, but our
  # keys are plain identifiers (no glob metacharacters), and the
  # replacement side is always taken literally, including embedded
  # newlines — unlike sed, no escaping of & or | is needed here.
  content="${content//___${key}___/$value}"
done

mkdir -p "$(dirname "$OUTPUT")"
printf '%s\n' "$content" > "$OUTPUT"

if grep -qE '___[A-Z0-9_]+___' "$OUTPUT"; then
  echo "ERROR: unresolved placeholder(s) left in $OUTPUT:" >&2
  grep -oE '___[A-Z0-9_]+___' "$OUTPUT" | sort -u >&2
  exit 1
fi

echo "Rendered $OUTPUT"
