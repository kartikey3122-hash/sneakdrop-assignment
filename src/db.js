"use strict";
// SQLite layer for Sneaker Drop.
// Beginner-friendly summary:
// - We keep ONE row in `inventory` with total = 20. We never oversell because
//   every buy/payment/expire runs inside a database transaction that recounts
//   stock (total - active reservations - paid orders) before changing anything.
// - better-sqlite3 is synchronous, so transactions run one-at-a-time in this
//   process. That serialisation is what makes concurrent "Buy at same second"
//   safe without overselling.
// - Extra safety nets at the database level:
//    * only one ACTIVE reservation per user (partial unique index)
//    * only one order per reservation (UNIQUE reservation_id)
//    * only one waiting queue spot per user (partial unique index)
//    * payment ids are unique so duplicate webhooks are ignored.

const Database = require("better-sqlite3");
const path = require("path");

const TOTAL_STOCK = 20;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

let db = null;
let reservationTtlMs = process.env.RESERVATION_TTL_MS
  ? parseInt(process.env.RESERVATION_TTL_MS, 10)
  : DEFAULT_TTL_MS;

function getReservationTtlMs() {
  return reservationTtlMs;
}

function setReservationTtlMs(ms) {
  reservationTtlMs = ms;
}

function openDatabase(dbPath) {
  const resolved = dbPath || process.env.DB_PATH || path.join(__dirname, "..", "sneakdrop.db");
  const database = new Database(resolved);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  initSchema(database);
  return database;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      sku TEXT PRIMARY KEY,
      total INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      status TEXT NOT NULL CHECK(status IN ('active','completed','expired','cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
      payment_id TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','allocated','removed','skipped')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT
    );
  `);

  // One active reservation per user (expired/completed rows stay for history).
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_reservation
    ON reservations(user_id) WHERE status = 'active';
  `);
  // One waiting queue spot per user.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_waiting_user
    ON queue_entries(user_id) WHERE status = 'waiting';
  `);

  const row = database.prepare("SELECT total FROM inventory WHERE sku = 'SNK-001'").get();
  if (!row) {
    database.prepare("INSERT INTO inventory (sku, total) VALUES ('SNK-001', ?)").run(TOTAL_STOCK);
  } else if (row.total !== TOTAL_STOCK) {
    // Always enforce exactly 20 pairs initial inventory per assignment.
    database.prepare("UPDATE inventory SET total = ? WHERE sku = 'SNK-001'").run(TOTAL_STOCK);
  }
}

function getDb(dbPath) {
  if (db) return db;
  db = openDatabase(dbPath);
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Test helper: wipe all transactional data and reset inventory to 20.
function resetDatabase(database) {
  const txn = database.transaction(() => {
    database.exec("DELETE FROM payments; DELETE FROM orders; DELETE FROM queue_entries; DELETE FROM reservations; DELETE FROM users;");
    database.prepare("INSERT OR REPLACE INTO inventory (sku, total) VALUES ('SNK-001', ?)").run(TOTAL_STOCK);
  });
  txn();
}

function ensureUser(database, userId) {
  database.prepare("INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)").run(userId, Date.now());
}

function countActiveReservations(database) {
  return database.prepare("SELECT COUNT(*) AS c FROM reservations WHERE status = 'active'").get().c;
}

function countPaidOrders(database) {
  return database.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
}

function getTotalStock(database) {
  return database.prepare("SELECT total FROM inventory WHERE sku = 'SNK-001'").get().total;
}

function getAvailable(database) {
  return getTotalStock(database) - countActiveReservations(database) - countPaidOrders(database);
}

function countPurchasedByUser(database, userId) {
  return database.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id = ?").get(userId).c;
}

function getActiveReservationForUser(database, userId) {
  return database.prepare("SELECT * FROM reservations WHERE user_id = ? AND status = 'active'").get(userId) || null;
}

module.exports = {
  TOTAL_STOCK,
  DEFAULT_TTL_MS,
  getDb,
  openDatabase,
  closeDb,
  resetDatabase,
  ensureUser,
  countActiveReservations,
  countPaidOrders,
  getTotalStock,
  getAvailable,
  countPurchasedByUser,
  getActiveReservationForUser,
  getReservationTtlMs,
  setReservationTtlMs,
};
