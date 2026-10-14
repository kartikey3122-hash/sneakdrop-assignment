"use strict";
const { createApp } = require("./app");
const dbModule = require("./db");

const PORT = process.env.PORT || 3000;
const app = createApp();

// Expiry sweeper: every second, expire overdue holds and refill from queue.
setInterval(() => {
  try {
    app.locals.sweepExpired();
  } catch (e) {
    console.error("sweep error:", e.message);
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`Sneaker Drop running at http://localhost:${PORT}`);
  console.log(`Stock: ${dbModule.TOTAL_STOCK} pairs, hold time: ${dbModule.getReservationTtlMs() / 60000} min`);
});
