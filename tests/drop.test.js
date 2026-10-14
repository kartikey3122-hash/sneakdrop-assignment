"use strict";
// Automated tests for Sneaker Drop.
// Covers: exact 20 inventory, concurrent buys (no oversell), expiry,
// queue FIFO fairness, 1-active + max-2 limits, duplicate & out-of-order webhooks,
// and payment-vs-expiry race.
//
// Run: npm test

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
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sneakdrop-")), "test.db");
  db = dbModule.openDatabase(dbFile);
  app = createApp({ db });
  api = request(app);
  return { app, api, db };
}

async function reset(ttlMs) {
  if (ttlMs) dbModule.setReservationTtlMs(ttlMs);
  await api.post("/api/test/reset").send(ttlMs ? { ttlMs } : {});
}

async function buy(userId) {
  return api.post("/api/buy").send({ userId });
}

async function webhook(payload) {
  return api.post("/api/webhooks/payment").send(payload);
}

async function state() {
  const r = await api.get("/api/debug/state");
  return r.body;
}

describe("Sneaker Drop", () => {
  beforeEach(() => freshApp());
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }); } catch {}
    dbModule.setReservationTtlMs(5 * 60 * 1000);
  });

  test("initial inventory is exactly 20 pairs", async () => {
    const s = await state();
    assert.strictEqual(s.total, 20);
    assert.strictEqual(s.sold, 0);
    assert.strictEqual(s.active, 0);
    assert.strictEqual(s.available, 20);
  });

  test("concurrent purchase attempts never oversell (50 racers, 20 pairs)", async () => {
    await reset();
    const users = Array.from({ length: 50 }, (_, i) => `racer_${i}`);
    const results = await Promise.all(users.map((u) => buy(u)));
    const reserved = results.filter((r) => r.body.reserved).length;
    const queued = results.filter((r) => r.body.queued).length;
    assert.strictEqual(reserved, 20, `expected 20 reservations, got ${reserved}`);
    assert.strictEqual(queued, 30, `expected 30 queued, got ${queued}`);
    const s = await state();
    assert.ok(s.active + s.sold <= 20, `oversold! active=${s.active} sold=${s.sold}`);
    assert.strictEqual(s.available, 0);
  });

  test("one active reservation per user; max 2 pairs total", async () => {
    await reset();
    const u = "limit_user";
    const r1 = await buy(u);
    assert.ok(r1.body.reserved, "first buy should reserve");
    const r2 = await buy(u);
    assert.strictEqual(r2.status, 409, "second concurrent hold must be rejected");

    // Pay for reservation 1 -> 1 purchased.
    const w1 = await webhook({ paymentId: "pay_lim_1", reservationId: r1.body.reservationId, userId: u, seq: 1 });
    assert.strictEqual(w1.status, 200);

    // Second pair allowed after first completed.
    const r3 = await buy(u);
    assert.ok(r3.body.reserved, "second pair should be reservable after paying first");
    const w2 = await webhook({ paymentId: "pay_lim_2", reservationId: r3.body.reservationId, userId: u, seq: 1 });
    assert.strictEqual(w2.status, 200);

    // Third pair forbidden (max 2).
    const r4 = await buy(u);
    assert.strictEqual(r4.status, 403, "third pair must be rejected (max 2)");
    const s = await state();
    const mine = s.orders.filter((o) => o.user_id === u);
    assert.strictEqual(mine.length, 2);
  });

  test("expiry returns stock (short TTL)", async () => {
    dbModule.setReservationTtlMs(250);
    await reset(250);
    const before = await state();
    assert.strictEqual(before.available, 20);
    const r = await buy("expiry_user");
    assert.ok(r.body.reserved);
    const mid = await state();
    assert.strictEqual(mid.available, 19);
    await sleep(450);
    await api.post("/api/test/sweep");
    const after = await state();
    assert.strictEqual(after.available, 20, "expired hold must return to stock");
    const res = after.reservations.find((x) => x.id === r.body.reservationId);
    assert.strictEqual(res.status, "expired");
  });

  test("waiting queue is FIFO and gets the freed pair with a fresh hold", async () => {
    dbModule.setReservationTtlMs(5 * 60 * 1000);
    await reset(5 * 60 * 1000);
    // Fill all 20 pairs.
    for (let i = 0; i < 20; i++) {
      const r = await buy(`holder_${i}`);
      assert.ok(r.body.reserved, `holder_${i} should reserve`);
    }
    // Three users line up in order.
    for (const q of ["queue_A", "queue_B", "queue_C"]) {
      const r = await buy(q);
      assert.ok(r.body.queued, `${q} should queue`);
    }
    let s = await state();
    assert.strictEqual(s.available, 0);

    // Force-expire one holder's reservation, then sweep.
    const victim = s.reservations.find((r) => r.status === "active");
    db.prepare("UPDATE reservations SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, victim.id);
    await api.post("/api/test/sweep");

    s = await state();
    // First in line (queue_A) must now hold a pair.
    const aRes = s.reservations.find((r) => r.user_id === "queue_A" && r.status === "active");
    assert.ok(aRes, "first in line (queue_A) must be allocated the freed pair");
    assert.ok(aRes.expires_at > Date.now(), "allocated pair gets a fresh 5-minute hold");
    // Others still waiting in order.
    const waiting = s.queue.filter((q) => q.status === "waiting").sort((x, y) => x.id - y.id);
    assert.deepStrictEqual(waiting.map((q) => q.user_id), ["queue_B", "queue_C"]);
    assert.strictEqual(s.available, 0, "freed pair went to queue, so available stays 0");
  });

  test("duplicate payment webhooks create only one order (idempotent)", async () => {
    await reset();
    const r = await buy("dup_user");
    const payload = { paymentId: "pay_dup_1", reservationId: r.body.reservationId, userId: "dup_user", seq: 1 };
    const w1 = await webhook(payload);
    assert.strictEqual(w1.status, 200);
    const w2 = await webhook(payload); // exact duplicate
    assert.strictEqual(w2.status, 200);
    assert.ok(w2.body.deduped, "duplicate must be flagged as deduped");
    const s = await state();
    const orders = s.orders.filter((o) => o.reservation_id === r.body.reservationId);
    assert.strictEqual(orders.length, 1, "only one order per reservation");
  });

  test("out-of-order webhooks create only one order (stale ignored)", async () => {
    await reset();
    const r = await buy("ooo_user");
    // Newer attempt arrives FIRST...
    const wNew = await webhook({ paymentId: "pay_ooo_new", reservationId: r.body.reservationId, userId: "ooo_user", seq: 2 });
    assert.strictEqual(wNew.status, 200);
    // ...then the stale older attempt arrives and must not double-sell.
    const wStale = await webhook({ paymentId: "pay_ooo_old", reservationId: r.body.reservationId, userId: "ooo_user", seq: 1 });
    assert.strictEqual(wStale.status, 200);
    assert.ok(wStale.body.deduped, "stale out-of-order webhook must be ignored");
    const s = await state();
    assert.strictEqual(s.orders.filter((o) => o.reservation_id === r.body.reservationId).length, 1);
    assert.ok(s.active + s.sold <= 20);
  });

  test("payment racing expiry: late payment loses, stock goes to queue", async () => {
    dbModule.setReservationTtlMs(300);
    await reset(300);
    // Fill 19 of 20 so 1 pair is left, then holder takes it and queuer lines up.
    for (let i = 0; i < 19; i++) await buy(`fill_${i}`);
    const hold = await buy("race_holder");
    assert.ok(hold.body.reserved);
    const q = await buy("race_queuer");
    assert.ok(q.body.queued);
    // Let the hold expire, then a LATE payment arrives.
    await sleep(500);
    const late = await webhook({ paymentId: "pay_late_1", reservationId: hold.body.reservationId, userId: "race_holder", seq: 1 });
    assert.strictEqual(late.status, 410, "late payment after expiry must be rejected");
    const s = await state();
    // Queuer must have been allocated the pair instead.
    const qRes = s.reservations.find((r) => r.user_id === "race_queuer" && r.status === "active");
    assert.ok(qRes, "freed pair must go to the waiting user, not the late payer");
    assert.strictEqual(s.orders.filter((o) => o.reservation_id === hold.body.reservationId).length, 0);
  });
});
