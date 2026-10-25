#!/usr/bin/env bash
# Starts the built host on demo data and checks it answers like a real install would.
set -euo pipefail
export KRAKEN_DATA_DIR="${RUNNER_TEMP:-/tmp}/kh-smoke"
rm -rf "$KRAKEN_DATA_DIR"
npm run seed
log="${RUNNER_TEMP:-/tmp}/kh-host.log"
(npm start > "$log" 2>&1 &)
for i in $(seq 1 30); do
  curl -sf http://localhost:7300/api/health >/dev/null && break
  sleep 1
done
if ! curl -sf http://localhost:7300/api/health >/dev/null; then
  echo "Host did not start. Log:"
  cat "$log"
  exit 1
fi
curl -sf http://localhost:7300/api/setup | grep -q '"needsSetup":false'
curl -sf http://localhost:7300/ | grep -q '<div id="root">'
curl -sf http://localhost:7300/client | grep -q '<div id="root">'
echo "host OK"
