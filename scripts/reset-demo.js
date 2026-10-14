"use strict";
// Safe reset for the LOCAL demo database (sneakdrop.db).
//
// What it does: deletes transactional demo rows (reservations, orders, queue,
// payments, users) and restores inventory to exactly 20 pairs. The schema is
// NEVER dropped — tables, indexes and constraints are preserved (same
// resetDatabase() helper the automated tests use).
//
// Safety:
// - Operates only on the local file resolved from DB_PATH or ./sneakdrop.db.
//   It never touches any other database.
// - Always creates a timestamped backup (sneakdrop.db.backup-<ts>) BEFORE
//   deleting anything, so demo purchases can be restored by copying back.
// - Dry-run by default: `node scripts/reset-demo.js` only prints what WOULD
//   be deleted. Pass --apply to actually reset.
// - Works whether or not the app server is running (WAL checkpoint first).
//
// Usage:
//   node scripts/reset-demo.js           # dry run: show current demo state
//   node scripts/reset-demo.js --apply   # backup + reset (npm run demo:reset)

const path = require("path");
const fs = require("fs");
const dbModule = require("../src/db");

const apply = process.argv.includes("--apply");
const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "sneakdrop.db");

function summarize(database, label) {
  const total = dbModule.getTotalStock(database);
  const sold = dbModule.countPaidOrders(database);
  const active = dbModule.countActiveReservations(database);
  const waiting = database.prepare("SELECT COUNT(*) AS c FROM queue_entries WHERE status = 'waiting'").get().c;
  const users = database.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  const payments = database.prepare("SELECT COUNT(*) AS c FROM payments").get().c;
  console.log(`[${label}] total=${total} sold=${sold} held(active)=${active} available=${total - sold - active} waiting=${waiting} users=${users} payments=${payments}`);
  return { total, sold, active, waiting };
}

const database = dbModule.openDatabase(dbPath);
console.log(`Demo database: ${dbPath}`);
const before = summarize(database, "before");

if (!apply) {
  console.log("Dry run — nothing deleted. Re-run with --apply to backup + reset.");
  database.close();
  process.exit(0);
}

// Checkpoint WAL so the backup file contains everything, then back up.
try {
  database.pragma("wal_checkpoint(TRUNCATE)");
} catch {}
const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(dbPath, backup);
console.log(`Backup created: ${backup}`);

dbModule.resetDatabase(database);
const after = summarize(database, "after ");
database.close();

const clean =
  after.total === 20 && after.sold === 0 && after.active === 0 &&
  after.waiting === 0 && after.total - after.sold - after.active === 20;
if (!clean) {
  console.error(`Reset verification FAILED (before: sold=${before.sold} active=${before.active}). Restore with: copy "${backup}" over "${dbPath}" while the app is stopped.`);
  process.exit(1);
}
console.log("Demo reset complete: 20 total, 0 sold, 0 held, 20 available, queue empty. Schema preserved.");
