# Kraken Hub — working notes

Read `docs/SPEC.md` before any feature work; it is the source of truth for product decisions.

## Workflow
- Claude writes the code; the owner (UncleKraken) tests on a live café floor and reports errors back.
- Reliability first: this runs a real business. Run type checks and tests before every push.
- Commit small, focused changes with clear messages. Never force-push `main`.

## Non-negotiables (from the spec)
- Operator-first UI: common actions in 1–3 taps.
- Every order/event carries a client-generated unique ID; the server must be idempotent.
- Money is an append-only ledger: never update or delete money rows; corrections are reversing entries.
- Every action is audit-logged with actor, time, before/after.
- All user-facing text goes through translation files (English + Albanian at launch).
- No feature paywalls yet; keep features separable so a Pro tier can be added later by configuration.

## Layout (planned)
- `host/` — Node.js + TypeScript server, SQLite
- `web/` — Hub Desk and Hub Manager web apps
- `client/` — C# / .NET agent for customer PCs
- `docs/` — spec and decisions
