"use strict";
// Express app factory for Sneaker Drop.
// Run with: node src/server.js
// Test with: require('./app').createApp(dbPath)

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const dbModule = require("./db");

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function createApp(options = {}) {
  const database = options.db || dbModule.getDb(options.dbPath);
  const app = express();
  app.use(express.json());

  // ---------- helpers (run inside transactions where noted) ----------

  function queuePosition(database, userId) {
    const rows = database
      .prepare("SELECT user_id FROM queue_entries WHERE status = 'waiting' ORDER BY created_at ASC, id ASC")
      .all();
    const idx = rows.findIndex((r) => r.user_id === userId);
    if (idx === -1) return null;
    return { position: idx + 1, total: rows.length };
  }

  // Give freed stock to the first ELIGIBLE waiting user (FIFO).
  // Must be called from inside a transaction OR from the sweeper which wraps it.
  // Eligibility: no active reservation, purchased < 2.
  function allocateFromQueue(database) {
    const allocated = [];
    for (;;) {
      const available = dbModule.getAvailable(database);
      if (available <= 0) break;
      const next = database
        .prepare("SELECT * FROM queue_entries WHERE status = 'waiting' ORDER BY created_at ASC, id ASC LIMIT 1")
        .get();
      if (!next) break;
      const purchased = dbModule.countPurchasedByUser(database, next.user_id);
      const active = dbModule.getActiveReservationForUser(database, next.user_id);
      if (purchased >= 2 || active) {
        // Skip ineligible users so one stuck user never blocks the line.
        database.prepare("UPDATE queue_entries SET status = 'skipped' WHERE id = ?").run(next.id);
        continue;
      }
      const now = Date.now();
      const resId = newId("res");
      database
        .prepare("INSERT INTO reservations (id, user_id, status, created_at, expires_at) VALUES (?, ?, 'active', ?, ?)")
        .run(resId, next.user_id, now, now + dbModule.getReservationTtlMs());
      database.prepare("UPDATE queue_entries SET status = 'allocated' WHERE id = ?").run(next.id);
      allocated.push({ userId: next.user_id, reservationId: resId });
    }
    return allocated;
  }

  // Expire every overdue active reservation, then refill from the queue.
  // Each expiry runs in its own IMMEDIATE transaction so it races safely
  // with payment webhooks (whoever commits first wins).
  function sweepExpired() {
    const overdue = database
      .prepare("SELECT id FROM reservations WHERE status = 'active' AND expires_at <= ?")
      .all(Date.now());
    const result = [];
    const txn = database.transaction((resId) => {
      const row = database.prepare("SELECT * FROM reservations WHERE id = ?").get(resId);
      if (!row || row.status !== "active") return null;
      // Re-check expiry inside the transaction (race safety).
      if (row.expires_at > Date.now()) return null;
      database.prepare("UPDATE reservations SET status = 'expired' WHERE id = ?").run(resId);
      const allocated = allocateFromQueue(database);
      return { expired: resId, allocated };
    });
    for (const r of overdue) {
      try {
        const out = txn(r.id);
        if (out) result.push(out);
      } catch (e) {
        // UNIQUE constraint etc. — ignore one bad row, keep sweeping others.
      }
    }
    return result;
  }

  // Idempotent payment confirmation. Safe to call twice / out of order / late.
  function handlePaymentWebhook({ paymentId, reservationId, userId, seq = 0, status = "succeeded" }) {
    if (!paymentId || !reservationId || !userId) {
      return { ok: false, code: 400, error: "paymentId, reservationId and userId are required" };
    }
    const txn = database.transaction(() => {
      // Idempotency: same paymentId seen before -> return previous outcome.
      const seen = database.prepare("SELECT * FROM payments WHERE payment_id = ?").get(paymentId);
      if (seen) {
        return { ok: true, deduped: true, outcome: seen.status, paymentId };
      }
      const res = database.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
      if (!res) {
        database
          .prepare("INSERT INTO payments (payment_id, reservation_id, user_id, seq, status, created_at, payload) VALUES (?, ?, ?, ?, 'unknown_reservation', ?, ?)")
          .run(paymentId, reservationId, userId, seq, Date.now(), JSON.stringify({ status }));
        return { ok: false, code: 404, error: "reservation not found" };
      }
      if (String(res.user_id) !== String(userId)) {
        return { ok: false, code: 403, error: "reservation belongs to a different user" };
      }
      // Out-of-order guard: if this reservation already completed, any other
      // payment for it is stale -> record and ignore (no second order).
      const existingOrder = database.prepare("SELECT * FROM orders WHERE reservation_id = ?").get(reservationId);
      if (existingOrder) {
        database
          .prepare("INSERT INTO payments (payment_id, reservation_id, user_id, seq, status, created_at, payload) VALUES (?, ?, ?, ?, 'duplicate_ignored', ?, ?)")
          .run(paymentId, reservationId, userId, seq, Date.now(), JSON.stringify({ status }));
        return { ok: true, deduped: true, outcome: "already_paid", orderId: existingOrder.id };
      }
      // Expiry wins if the reservation is past its deadline, even if the
      // sweeper hasn't marked it expired yet. This is the payment-vs-expiry race:
      // exactly one of (pay succeeds) or (expiry + queue refill) happens.
      if (res.status !== "active" || res.expires_at <= Date.now()) {
        if (res.status === "active") {
          database.prepare("UPDATE reservations SET status = 'expired' WHERE id = ?").run(reservationId);
          allocateFromQueue(database);
        }
        database
          .prepare("INSERT INTO payments (payment_id, reservation_id, user_id, seq, status, created_at, payload) VALUES (?, ?, ?, ?, 'late_rejected', ?, ?)")
          .run(paymentId, reservationId, userId, seq, Date.now(), JSON.stringify({ status }));
        return { ok: false, code: 410, error: "reservation expired, payment rejected" };
      }
      // Purchase limit: max 2 pairs total per user.
      const purchased = dbModule.countPurchasedByUser(database, userId);
      if (purchased >= 2) {
        database.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(reservationId);
        database
          .prepare("INSERT INTO payments (payment_id, reservation_id, user_id, seq, status, created_at, payload) VALUES (?, ?, ?, ?, 'limit_rejected', ?, ?)")
          .run(paymentId, reservationId, userId, seq, Date.now(), JSON.stringify({ status }));
        allocateFromQueue(database);
        return { ok: false, code: 403, error: "purchase limit (2) reached" };
      }
      // Success path: mark completed + create exactly one order.
      database.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(reservationId);
      const orderId = newId("ord");
      database
        .prepare("INSERT INTO orders (id, user_id, reservation_id, payment_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(orderId, userId, reservationId, paymentId, Date.now());
      database
        .prepare("INSERT INTO payments (payment_id, reservation_id, user_id, seq, status, created_at, payload) VALUES (?, ?, ?, ?, 'processed', ?, ?)")
        .run(paymentId, reservationId, userId, seq, Date.now(), JSON.stringify({ status }));
      return { ok: true, orderId, paymentId };
    });
    try {
      const out = txn();
      if (!out.ok) return out;
      return out;
    } catch (e) {
      // UNIQUE violations mean a concurrent duplicate webhook already won.
      if (String(e.message).includes("UNIQUE")) {
        return { ok: true, deduped: true, outcome: "race_duplicate_ignored" };
      }
      throw e;
    }
  }

  // ---------- FAKE payment system (clearly labelled simulation) ----------
  // Real payment providers send a separate "payment succeeded" webhook that can
  // arrive late, twice, or out of order. We simulate that with timers calling
  // handlePaymentWebhook() after a delay. Nothing here charges real money.
  // Pending timer ids are tracked so tests can cancel stragglers on teardown
  // (otherwise a duplicate/out-of-order webhook scheduled at ~1200ms can fire
  // after the test's DB was closed and either error or pollute the next test).
  const pendingFakeTimers = [];
  function scheduleFakeWebhooks({ paymentId, reservationId, userId, scenario, delayMs }) {
    const jobs = [];
    if (scenario === "duplicate") {
      jobs.push({ pid: paymentId, seq: 1, after: 700 });
      jobs.push({ pid: paymentId, seq: 1, after: 1200 }); // same id -> duplicate
    } else if (scenario === "out_of_order") {
      // Newer seq arrives FIRST, older seq arrives second and must be ignored.
      const staleId = paymentId + "_seq1";
      jobs.push({ pid: paymentId, seq: 2, after: 600 });
      jobs.push({ pid: staleId, seq: 1, after: 1100 });
    } else if (scenario === "delayed" || scenario === "late") {
      jobs.push({ pid: paymentId, seq: 1, after: delayMs || 3000 });
    } else {
      jobs.push({ pid: paymentId, seq: 1, after: 700 }); // normal
    }
    for (const j of jobs) {
      const timerId = setTimeout(() => {
        try {
          const out = handlePaymentWebhook({ paymentId: j.pid, reservationId, userId, seq: j.seq, status: "succeeded" });
          console.log(`[fake-psp] webhook delivered: reservation=${reservationId} payment=${j.pid} seq=${j.seq} -> ${out.ok ? "ok" + (out.deduped ? " (deduped)" : " order=" + (out.orderId || "")) : "rejected " + (out.error || "")}`);
        } catch (e) {
          // simulation must never crash the server
          console.log(`[fake-psp] webhook error: reservation=${reservationId} payment=${j.pid} ${e.message}`);
        }
      }, j.after);
      pendingFakeTimers.push(timerId);
    }
    return jobs.length;
  }
  function cancelFakeWebhooks() {
    for (const t of pendingFakeTimers) clearTimeout(t);
    pendingFakeTimers.length = 0;
  }

  // ---------- API routes ----------

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // One-page status: stock left, my hold + countdown, queue position, purchases.
  app.get("/api/status", (req, res) => {
    const userId = req.query.userId || req.headers["x-user-id"];
    const total = dbModule.getTotalStock(database);
    const sold = dbModule.countPaidOrders(database);
    const activeCount = dbModule.countActiveReservations(database);
    const available = total - sold - activeCount;
    const waitingCount = database.prepare("SELECT COUNT(*) AS c FROM queue_entries WHERE status = 'waiting'").get().c;
    const out = { total, sold, activeCount, available, waitingCount, ttlMs: dbModule.getReservationTtlMs(), now: Date.now() };
    if (userId) {
      dbModule.ensureUser(database, String(userId));
      const myRes = dbModule.getActiveReservationForUser(database, String(userId));
      // Lazily expire my own row in reads so countdowns look right even
      // between sweeper ticks (sweeper still does the queue refill).
      if (myRes && myRes.expires_at <= Date.now()) {
        sweepExpired();
        out.myReservation = null;
      } else {
        out.myReservation = myRes
          ? { id: myRes.id, expiresAt: myRes.expires_at, secondsLeft: Math.max(0, Math.ceil((myRes.expires_at - Date.now()) / 1000)) }
          : null;
      }
      out.myQueue = queuePosition(database, String(userId));
      out.purchasedCount = dbModule.countPurchasedByUser(database, String(userId));
      out.myOrders = database.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(String(userId));
    }
    res.json(out);
  });

  // Buy: reserve 1 pair, or auto-join the queue when stock is unavailable.
  app.post("/api/buy", (req, res) => {
    const userId = String(req.body.userId || req.headers["x-user-id"] || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    try {
      const txn = database.transaction(() => {
        dbModule.ensureUser(database, userId);
        if (dbModule.countPurchasedByUser(database, userId) >= 2) {
          return { code: 403, body: { error: "purchase limit reached (max 2 pairs per user)" } };
        }
        if (dbModule.getActiveReservationForUser(database, userId)) {
          return { code: 409, body: { error: "you already hold 1 pair; pay or wait for expiry" } };
        }
        const waitingCount = database.prepare("SELECT COUNT(*) AS c FROM queue_entries WHERE status = 'waiting'").get().c;
        const available = dbModule.getAvailable(database);
        // Fairness: if a line already exists, newcomers queue behind it even
        // if a pair looks free (it may be mid-allocation).
        if (available <= 0 || waitingCount > 0) {
          const existing = database.prepare("SELECT * FROM queue_entries WHERE user_id = ? AND status = 'waiting'").get(userId);
          if (existing) {
            const pos = queuePosition(database, userId);
            return { code: 200, body: { queued: true, already: true, queue: pos } };
          }
          const now = Date.now();
          database.prepare("INSERT INTO queue_entries (user_id, status, created_at) VALUES (?, 'waiting', ?)").run(userId, now);
          const pos = queuePosition(database, userId);
          return { code: 200, body: { queued: true, queue: pos, message: "sold out — you joined the waiting line" } };
        }
        const now = Date.now();
        const resId = newId("res");
        database
          .prepare("INSERT INTO reservations (id, user_id, status, created_at, expires_at) VALUES (?, ?, 'active', ?, ?)")
          .run(resId, userId, now, now + dbModule.getReservationTtlMs());
        return {
          code: 200,
          body: { reserved: true, reservationId: resId, expiresAt: now + dbModule.getReservationTtlMs(), ttlMs: dbModule.getReservationTtlMs() },
        };
      });
      const out = txn();
      return res.status(out.code).json(out.body);
    } catch (e) {
      if (String(e.message).includes("uniq_active_reservation") || String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "you already hold 1 pair (concurrent buy blocked)" });
      }
      throw e;
    }
  });

  // Explicit queue join (same fairness rules as Buy when sold out).
  app.post("/api/queue/join", (req, res) => {
    const userId = String(req.body.userId || req.headers["x-user-id"] || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    dbModule.ensureUser(database, userId);
    if (dbModule.countPurchasedByUser(database, userId) >= 2) {
      return res.status(403).json({ error: "purchase limit reached, cannot queue" });
    }
    if (dbModule.getActiveReservationForUser(database, userId)) {
      return res.status(409).json({ error: "you already hold a pair" });
    }
    try {
      database.prepare("INSERT INTO queue_entries (user_id, status, created_at) VALUES (?, 'waiting', ?)").run(userId, Date.now());
    } catch (e) {
      // already waiting -> just report position
    }
    return res.json({ queued: true, queue: queuePosition(database, userId) });
  });

  app.post("/api/queue/leave", (req, res) => {
    const userId = String(req.body.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    database.prepare("UPDATE queue_entries SET status = 'removed' WHERE user_id = ? AND status = 'waiting'").run(userId);
    return res.json({ left: true });
  });

  // Start a FAKE (simulated) payment for an active reservation.
  // scenario: normal | duplicate | delayed | late | out_of_order
  app.post("/api/pay", (req, res) => {
    const { userId, reservationId, scenario = "normal", delayMs } = req.body || {};
    if (!userId || !reservationId) return res.status(400).json({ error: "userId and reservationId are required" });
    const r = database.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
    if (!r) return res.status(404).json({ error: "reservation not found" });
    if (String(r.user_id) !== String(userId)) return res.status(403).json({ error: "not your reservation" });
    if (r.status !== "active" || r.expires_at <= Date.now()) {
      sweepExpired();
      return res.status(410).json({ error: "reservation expired" });
    }
    const paymentId = newId("pay");
    const scheduled = scheduleFakeWebhooks({ paymentId, reservationId, userId: String(userId), scenario, delayMs });
    console.log(`[fake-psp] payment started: user=${userId} reservation=${reservationId} payment=${paymentId} scenario=${scenario} webhooks=${scheduled}`);
    return res.json({
      simulated: true,
      message: "FAKE payment started (no real money). Webhook will arrive shortly.",
      paymentId,
      scenario,
      webhooksScheduled: scheduled,
    });
  });

  // Fake PSP webhook endpoint (also used by tests to replay duplicates).
  app.post("/api/webhooks/payment", (req, res) => {
    const out = handlePaymentWebhook(req.body || {});
    if (!out.ok) return res.status(out.code || 400).json(out);
    return res.json({ ...out, simulated: true });
  });

  // Debug/state for tests and the frontend.
  app.get("/api/debug/state", (req, res) => {
    res.json({
      total: dbModule.getTotalStock(database),
      sold: dbModule.countPaidOrders(database),
      active: dbModule.countActiveReservations(database),
      available: dbModule.getAvailable(database),
      reservations: database.prepare("SELECT * FROM reservations ORDER BY created_at").all(),
      orders: database.prepare("SELECT * FROM orders ORDER BY created_at").all(),
      queue: database.prepare("SELECT * FROM queue_entries ORDER BY created_at").all(),
      payments: database.prepare("SELECT * FROM payments ORDER BY created_at").all(),
    });
  });

  // Test-only reset (used by automated tests to get a clean 20-pair stock).
  app.post("/api/test/reset", (req, res) => {
    if (req.body && req.body.ttlMs) dbModule.setReservationTtlMs(parseInt(req.body.ttlMs, 10));
    dbModule.resetDatabase(database);
    res.json({ reset: true, total: dbModule.getTotalStock(database), ttlMs: dbModule.getReservationTtlMs() });
  });

  app.post("/api/test/sweep", (req, res) => {
    res.json({ swept: sweepExpired() });
  });

  // Serve the single-page frontend.
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  // Expose internals for tests.
  app.locals.database = database;
  app.locals.sweepExpired = sweepExpired;
  app.locals.handlePaymentWebhook = handlePaymentWebhook;
  app.locals.cancelFakeWebhooks = cancelFakeWebhooks;

  return app;
}

module.exports = { createApp };
