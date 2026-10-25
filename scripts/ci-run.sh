#!/usr/bin/env bash
# Runs a CI step; on failure, publishes the last lines of output as a GitHub annotation
# so the error is readable through the API without downloading the full log.
set -o pipefail
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  tail -n 80 "$log" | sed -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}' > "$log.tail"
  echo "::error title=Failed: $*::$(cat "$log.tail")"
fi
exit "$status"
