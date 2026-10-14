"use strict";
// Regression tests for the reported bug: clicking "Pay · normal" showed
// "FAKE payment started..." forever with no completed payment.
//
// Root cause was frontend-only (payMsg never updated after the webhook), but the
// backend path POST /api/pay -> scheduled timer -> handlePaymentWebhook ->
// /api/status had NO end-to-end test coverage: existing tests only POSTed to
// /api/webhooks/payment directly. These tests drive the real user flow through
// /api/pay (timers included) and assert exactly one order per purchase.
//
// Run: npm test (runs tests/*.test.js)

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const request = require("supertest");
const dbModule = require("../src/db");
const { createApp } = require("../src/app");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let db;
let dbFile;
let api;

function freshApp(ttlMs = 5 * 60 * 1000) {
  dbModule.setReservationTtlMs(ttlMs);
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sneakdrop-payflow-")), "test.db");
  db = dbModule.openDatabase(dbFile);
  app = createApp({ db });
  api = request(app);
}

// Poll /api/status until condition or timeout (mirrors frontend polling).
async function waitForStatus(userId, predicate, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const s = await api.get(`/api/status?userId=${encodeURIComponent(userId)}`);
    if (predicate(s.body)) return s.body;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for status: ${JSON.stringify(s.body)}`);
    }
    await sleep(250);
  }
}

describe("Pay flow end-to-end (POST /api/pay -> simulated webhook -> status)", () => {
  beforeEach(() => freshApp());
  afterEach(() => {
    try { app.locals.cancelFakeWebhooks(); } catch {}
    try { db.close(); } catch {}
    try { fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }); } catch {}
    dbModule.setReservationTtlMs(5 * 60 * 1000);
  });

  test("Pay normal completes: one order appears in status (was stuck on 'started...')", async () => {
    const u = "payflow_normal";
    const buy = await api.post("/api/buy").send({ userId: u });
    assert.ok(buy.body.reserved, "buy should reserve");

    const pay = await api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "normal" });
    assert.strictEqual(pay.status, 200);
    assert.strictEqual(pay.body.simulated, true);
    assert.strictEqual(pay.body.webhooksScheduled, 1);

    // Frontend polls /api/status every 2s; the webhook lands at ~700ms.
    const s = await waitForStatus(u, (b) => b.purchasedCount === 1);
    assert.strictEqual(s.myOrders.length, 1, "exactly one order per purchase");
    assert.strictEqual(s.myOrders[0].reservation_id, buy.body.reservationId);
    assert.strictEqual(s.myReservation, null, "hold clears after payment");
  });

  test("Pay duplicate scenario still creates exactly one order", async () => {
    const u = "payflow_dup";
    const buy = await api.post("/api/buy").send({ userId: u });
    const pay = await api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "duplicate" });
    assert.strictEqual(pay.body.webhooksScheduled, 2, "duplicate schedules the webhook twice");
    const s = await waitForStatus(u, (b) => b.purchasedCount === 1);
    assert.strictEqual(s.myOrders.length, 1);
    // Wait past the 1200ms duplicate before asserting: the replay must not
    // create a second order (deduped via payments PK + existing-order guard).
    await sleep(900);
    const s2 = await api.get(`/api/status?userId=${encodeURIComponent(u)}`);
    assert.strictEqual(s2.body.myOrders.length, 1, "duplicate webhook must not create a second order");
    const st = await api.get("/api/debug/state");
    assert.strictEqual(st.body.orders.filter((o) => o.reservation_id === buy.body.reservationId).length, 1);
  });

  test("Pay out_of_order scenario still creates exactly one order", async () => {
    const u = "payflow_ooo";
    const buy = await api.post("/api/buy").send({ userId: u });
    const pay = await api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "out_of_order" });
    assert.strictEqual(pay.body.webhooksScheduled, 2);
    const s = await waitForStatus(u, (b) => b.purchasedCount === 1);
    assert.strictEqual(s.myOrders.length, 1);
    // Wait past the 1100ms stale replay before asserting one order.
    await sleep(900);
    const s2 = await api.get(`/api/status?userId=${encodeURIComponent(u)}`);
    assert.strictEqual(s2.body.myOrders.length, 1, "stale out-of-order webhook must not create a second order");
    const st = await api.get("/api/debug/state");
    assert.strictEqual(st.body.orders.filter((o) => o.reservation_id === buy.body.reservationId).length, 1);
  });

  test("double-clicking Pay creates exactly one order (two payment intents, one winner)", async () => {
    const u = "payflow_doubleclick";
    const buy = await api.post("/api/buy").send({ userId: u });
    const [p1, p2] = await Promise.all([
      api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "normal" }),
      api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "normal" }),
    ]);
    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p2.status, 200);
    assert.notStrictEqual(p1.body.paymentId, p2.body.paymentId, "each click mints its own payment intent");
    const s = await waitForStatus(u, (b) => b.purchasedCount === 1);
    // Second webhook must be deduped via the existing-order guard.
    await sleep(1200);
    const s2 = await api.get(`/api/status?userId=${encodeURIComponent(u)}`);
    assert.strictEqual(s2.body.myOrders.length, 1, "double Pay must not double-sell");
    assert.strictEqual(s.myOrders[0].reservation_id, buy.body.reservationId);
  });

  test("two separate Buy+Pay purchases show two order IDs (history, not duplicates)", async () => {
    const u = "payflow_two";
    for (let i = 0; i < 2; i++) {
      const buy = await api.post("/api/buy").send({ userId: u });
      assert.ok(buy.body.reserved, `buy #${i + 1} should reserve`);
      await api.post("/api/pay").send({ userId: u, reservationId: buy.body.reservationId, scenario: "normal" });
      const s = await waitForStatus(u, (b) => b.purchasedCount === i + 1, 10000);
      assert.strictEqual(s.myOrders.length, i + 1);
    }
    const st = await api.get("/api/debug/state");
    const mine = st.body.orders.filter((o) => o.user_id === u);
    assert.strictEqual(mine.length, 2);
    assert.notStrictEqual(mine[0].reservation_id, mine[1].reservation_id, "each purchase has its own reservation");
    assert.notStrictEqual(mine[0].id, mine[1].id, "each purchase has its own order id");
  });
});
