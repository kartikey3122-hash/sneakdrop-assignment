# Notes

## How to run

Requirements: **Node.js 18+** (developed on Node 25). No external database —
SQLite is embedded (`better-sqlite3`, installed via npm).

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

To run the automated tests (exact command):

```bash
npm test
# runs: node --test tests/drop.test.js tests/payflow.test.js
```

Expected: 13 tests, 13 pass, 0 fail (verified 2026-10-14 on Node v25.9.0;
`drop.test.js` 8/8, `payflow.test.js` 5/5). Tests use isolated temp
databases only — the live `sneakdrop.db` is never touched by the suite.

| Env var | Default | Use |
|---|---|---|
| `PORT` | `3000` | Change the HTTP port |
| `DB_PATH` | `./sneakdrop.db` | Point at a different SQLite file |
| `RESERVATION_TTL_MS` | `300000` | Hold length; tests override it for fast expiry |

The SQLite file (`*.db*`) is git-ignored, so each fresh clone starts with exactly
20 pairs. To wipe local data, stop the server and delete `sneakdrop.db*`.

## Requirements checklist (all covered)

- Node.js, Express, SQLite, HTML, CSS, frontend JS — yes.
- Initial inventory exactly 20 — `inventory` row `SNK-001 = 20`, enforced on boot.
- Buy holds 1 pair for 5 minutes — `reservations` with `expires_at = now + TTL`.
- Unpaid holds expire back to stock — 1-second sweeper + lazy check on reads.
- 1 active hold + max 2 bought per user — partial unique index + transaction checks.
- FIFO waiting queue when sold out — `queue_entries` ordered by `(created_at, id)`.
- Freed pair → first eligible waiter with fresh 5 min — `allocateFromQueue()`.
- Fake payment with delayed/duplicate/out-of-order — `/api/pay` scenarios + `/api/webhooks/payment`.
- No oversell / no duplicates — transactions + unique constraints + idempotent webhooks.
- Payment-vs-expiry race safe — single transaction re-checks deadline; one winner.
- One page: stock, hold, countdown, queue — `public/index.html`.
- SQLite persistence — inventory, reservations, orders, queue, payments tables.
- Automated tests — `tests/drop.test.js` (concurrency, expiry, FIFO, limits, duplicate/out-of-order, race) + `tests/payflow.test.js` (end-to-end `/api/pay` → timer → status for normal/duplicate/out-of-order/double-click/two-purchase history).
- README + NOTES — this file + `README.md`.

## Key decisions (plain language)

1. **better-sqlite3 (synchronous) instead of async sqlite.** Writes run
   one-at-a-time in one process, so a "count stock, then insert" transaction
   can't be interleaved with another buy. That is the core anti-oversell trick.
2. **Never store "available" as a number you add/subtract.** It is always
   *computed*: `total − active holds − paid orders`. A counter column would drift
   under retries; a computed value can't.
3. **Two safety nets, not one.** App-level transaction checks *plus* DB unique
   indexes (one active hold per user, one order per reservation, one waiting
   spot per user, unique payment ids). If two requests race, the loser gets a
   clean `409`/dedupe instead of a double-sell.
4. **Idempotent webhooks.** Same `paymentId` twice → second is recorded and
   ignored. Different payment for an already-paid reservation → ignored. Late
   payment after expiry → rejected (`410`) and the pair stays with the queue.
5. **Queue fairness with a guard.** If a line exists, new buyers queue behind it
   even if stock momentarily looks free. Ineligible waiters (2 already bought,
   or currently holding) are marked `skipped` so they never jam the line.
6. **Fake PSP clearly labelled.** Every response says `simulated: true` / "FAKE
   payment"; the frontend section is titled "Fake checkout (simulation)".
   Scenarios: normal, duplicate (same id twice), out_of_order (newer seq first),
   delayed/late (configurable delay).
7. **Fast tests, slow production.** Hold length is one global (`TTL_MS`) the
   tests shrink to ~250–300 ms, so expiry/race tests run in under a second
   while production stays at 5 minutes.

## Tests (what each proves)

`drop.test.js` (direct API + webhook level):

1. Initial inventory is exactly 20.
2. 50 simultaneous buys → exactly 20 holds + 30 queued, `active + sold ≤ 20`.
3. Second hold blocked (`409`); third lifetime pair blocked (`403`, max 2).
4. Hold expires → stock returns to 20, row becomes `expired`.
5. Queue FIFO: freed pair goes to waiter #1 with fresh deadline; others keep order.
6. Duplicate webhook → one order, second flagged `deduped`.
7. Out-of-order webhooks → one order, stale ignored.
8. Late payment after expiry → `410`, pair goes to waiter, no order for late payer.

`payflow.test.js` (end-to-end user flow via `POST /api/pay` timers, the previously
untested path behind the "stuck on Webhook arriving soon" report):

9. Pay normal → exactly one order visible in `/api/status`.
10. Pay duplicate scenario → still one order after the replay lands.
11. Pay out-of-order scenario → still one order after the stale replay lands.
12. Double-clicked Pay (two intents) → one winner, one deduped.
13. Two Buy+Pay purchases → two distinct order IDs (history, not duplicates).

## Frontend redesign notes

- Premium dark theme lives entirely in `public/` (backend + schema untouched):
  graphite background, warm-white text, electric-lime accent, editorial headline,
  live stat grid + segmented stock bar, `m:ss` countdown with sub-60s pulse,
  simulation-labelled checkout, FIFO queue panel, orders with PAID badges.
- No external imagery, fonts, or JS frameworks — the hero shoe is an inline SVG,
  so there are no external asset dependencies to document beyond "none".
- UI state always follows the backend: every figure comes from `/api/status`,
  success renders only on backend-confirmed orders, and buttons disable while a
  reservation, payment, or limit forbids the action. Respects
  `prefers-reduced-motion` and uses `:focus-visible` + `aria-live` regions.

## What I would add with more time

Multi-process locking (SQLite WAL is fine for one server; a Redis lock or
Postgres `SELECT … FOR UPDATE` would scale horizontally), real auth instead of
`userId` strings, and a screen recording (requested in the assignment brief —
not included in this repo).
