# Kraken Hub — central hub

The central hub rolls up reporting across multiple branches. Each branch keeps running fully on
its own; the hub only collects daily summaries so head office sees combined numbers. A single-branch
café never needs it.

What leaves a branch: daily totals (revenue, cash/card, tips, sessions) and per-product daily totals.
No customer-level data, no tabs, no names.

## Running the hub

Run it on a small always-on server (a cheap VPS, or any machine that stays on and is reachable from
the branches). It needs Node 22+.

```
npm run build
PORT=7400 npm run start:hub
```

Data is stored in `hub/data/kraken-hub-central.db` (override with `KRAKEN_HUB_DATA_DIR`). The
dashboard is at `http://<hub-host>:7400/`.

## Pointing a branch at the hub

Set these environment variables on the branch's host PC (leave them unset to run standalone):

| Variable                  | Example                     | Meaning                                  |
| ------------------------- | --------------------------- | ---------------------------------------- |
| `KRAKEN_HUB_URL`          | `http://hub.example.com:7400` | Where the hub is reachable             |
| `KRAKEN_BRANCH_ID`        | `tirana`                    | Stable id for this branch                |
| `KRAKEN_BRANCH_NAME`      | `Tirana`                    | Display name on the dashboard            |
| `KRAKEN_BRANCH_SECRET`    | a long random string        | Shared secret; the hub remembers the first one it sees for a branch and rejects any other |
| `KRAKEN_SYNC_INTERVAL_MS` | `300000` (default)          | How often to push (optional)             |

## Reliability

- **Offline-first.** The branch keeps taking money whether or not the hub is reachable. Each push
  recomputes the rollup from the branch's own ledger, so there's no queue to lose; when the link
  comes back, the next push reconciles everything.
- **Idempotent.** Re-pushing a day replaces that day's stored numbers, so retries and catch-ups can't
  double-count.
- On startup the branch pushes its full history; after that it pushes a short trailing window often, to
  keep today fresh and absorb brief outages.
