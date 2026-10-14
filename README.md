# Sneaker Drop — 20 pairs, no overselling

A complete limited-sneaker sale system: Node.js + Express + SQLite (better-sqlite3)
backend, one-page HTML/CSS/JS frontend, fake payment simulator, FIFO waiting queue,
and automated tests.

Last time the shop sold 51 pairs with only 20 in stock. This version makes that
impossible: every stock change runs inside a database transaction that recounts
`available = 20 − active holds − paid orders` before writing, plus database-level
unique indexes as a second safety net.

## Quick start

Requirements: **Node.js 18+** (tested on Node 25). No separate database to install —
SQLite is embedded via `better-sqlite3`. Internet needed once for `npm install`.

```bash
npm install
npm start        # serves http://localhost:3000
```

Open **http://localhost:3000** — a dark editorial storefront (hero, live inventory,
reservation countdown, simulated checkout, waiting line, orders). All figures are
live backend data; the product visual is an inline SVG (no external imagery).

```bash
npm test         # 13 automated tests (node:test + supertest)
```

Optional env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./sneakdrop.db` | SQLite file |
| `RESERVATION_TTL_MS` | `300000` (5 min) | Hold duration |

## How it works (beginner-friendly)

Think of the 20 pairs as 20 tokens on a table.

- **Buy** → if a token is free (and nobody is waiting in line), one token is put
  in your hands with a 5-minute timer (`reservations` row, status `active`).
  If no token is free, you get a numbered ticket in the waiting line instead
  (`queue_entries` row, FIFO by creation time).
- **Pay** → starts a **FAKE, simulated** payment (no real money). A pretend
  payment company calls back on `/api/webhooks/payment` with "succeeded".
  The callback can be normal, duplicated, delayed, late, or out-of-order —
  the server handles all of them and still creates at most **one order per
  reservation** (payment ids are unique; repeats are ignored).
- **Expiry** → a sweeper runs every second. Overdue holds become `expired`,
  the token returns to the table, and the first *eligible* person in line
  immediately gets it with a fresh 5-minute timer. Ineligible people
  (already holding, or already bought 2) are skipped, never blocking the line.
- **Payment-vs-expiry race** → both paths run in a single transaction and
  re-check the deadline inside it. Exactly one wins: either the payment
  completes the order, or the hold expires and the pair goes to the queue.
  A payment arriving after expiry gets HTTP `410` and is recorded as
  `late_rejected`.

Rules enforced: 1 active hold per user (partial unique index +
transaction check), max 2 paid pairs per user, FIFO queue, idempotent webhooks.

## API

- `GET /` — the shop page
- `GET /api/status?userId=X` — stock, your hold + seconds left, queue position, purchases, orders
- `POST /api/buy {userId}` — reserve or auto-queue
- `POST /api/queue/join|leave {userId}`
- `POST /api/pay {userId, reservationId, scenario, delayMs}` — start fake payment;
  `scenario`: `normal` · `duplicate` · `out_of_order` · `delayed` · `late`
- `POST /api/webhooks/payment {paymentId, reservationId, userId, seq}` — fake PSP callback (idempotent)
- `GET /api/debug/state` — full DB snapshot (handy for demos)
- `POST /api/test/reset {ttlMs?}` · `POST /api/test/sweep` — test helpers

## Project layout

```
src/db.js       SQLite schema, constraints, stock-count helpers
src/app.js      Express app: buy/queue/pay/webhook/status + expiry + queue allocator
src/server.js   Listener + 1-second expiry sweeper
public/         index.html, style.css, app.js (premium dark storefront, zero deps)
tests/drop.test.js     8 tests: inventory, concurrency, limits, expiry, FIFO, webhooks, race
tests/payflow.test.js  5 tests: end-to-end POST /api/pay -> simulated webhook -> status
NOTES.md        run steps + design decisions
```

## Frontend notes

- Zero dependencies, zero external assets (system fonts, inline SVG shoe
  illustration) — works fully offline once `npm install` has run.
- Payment success is rendered **only after backend confirmation**: the UI tracks
  the pending payment and reconciles it against `/api/status` polls, so
  duplicate/delayed/out-of-order callbacks can never flash a false success.
- Buttons disable themselves when the current state forbids the action
  (holding, payment in flight, limit reached, already in line).

See **NOTES.md** for setup details, test descriptions, and key decisions.
