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

# --- Central hub: starts, accepts a branch push, aggregates it, serves the dashboard ---
export KRAKEN_HUB_DATA_DIR="${RUNNER_TEMP:-/tmp}/kh-hub-smoke"
rm -rf "$KRAKEN_HUB_DATA_DIR"
hublog="${RUNNER_TEMP:-/tmp}/kh-hub.log"
(npm run start:hub > "$hublog" 2>&1 &)
for i in $(seq 1 30); do
  curl -sf http://localhost:7400/api/health >/dev/null && break
  sleep 1
done
if ! curl -sf http://localhost:7400/api/health >/dev/null; then
  echo "Hub did not start. Log:"; cat "$hublog"; exit 1
fi
curl -sf -X POST http://localhost:7400/ingest -H 'content-type: application/json' \
  -d '{"branchId":"smoke","branchName":"Smoke","secret":"smoke-secret-123456","tzOffsetMin":0,"days":[{"summary":{"day":"2026-11-10","revenueMinor":1000,"cashMinor":1000,"cardMinor":0,"tipMinor":0,"refundMinor":0,"paymentCount":1,"sessionCount":1},"products":[{"day":"2026-11-10","name":"Red Bull","qty":2,"revenueMinor":600}]}]}' | grep -q '"days":1'
curl -sf "http://localhost:7400/api/overview?from=2026-11-01&to=2026-11-30" | grep -q '"revenueMinor":1000'
curl -sf http://localhost:7400/index.html | grep -q 'Kraken Hub'
echo "hub OK"
