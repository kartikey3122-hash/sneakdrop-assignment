"use strict";
// SNEAKER DROP storefront.
// Same backend contract as before: GET /api/status, POST /api/buy,
// POST /api/queue/join|leave, POST /api/pay, all keyed by an anonymous userId.
// Payment success is NEVER shown until the backend confirms it: a pendingPayment
// record is reconciled against subsequent /api/status polls (the simulated
// webhook lands ~0.6-1.2s after /api/pay, polls run every 2s).

function getUserId() {
  let id = localStorage.getItem("sneakdrop_user");
  if (!id) {
    id = "user_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("sneakdrop_user", id);
  }
  return id;
}

let userId = getUserId();
let lastReservation = null;
let pendingPayment = null;
let buying = false;
let paying = false;
let joining = false;

const $ = (id) => document.getElementById(id);
const payButtons = () => Array.from(document.querySelectorAll("[data-pay]"));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setFeedback(el, text, tone) {
  el.textContent = text;
  el.className = tone ? `feedback ${tone}` : "feedback";
}

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

async function refresh() {
  let data;
  try {
    ({ data } = await api(`/api/status?userId=${encodeURIComponent(userId)}`));
  } catch {
    return; // offline: keep last painted state, next poll retries
  }
  if (data.total === undefined) return;

  const purchased = data.purchasedCount ?? 0;
  const soldOut = data.available <= 0;
  lastReservation = data.myReservation;

  // ---- hero + inventory (all from real backend data) ----
  $("available").textContent = data.available;
  const heroAvail = $("availableHero");
  if (heroAvail) heroAvail.textContent = data.available;
  $("total").textContent = data.total;
  $("sold").textContent = data.sold;
  $("held").textContent = data.activeCount;
  $("lineTotal").textContent = data.waitingCount;
  $("userId").textContent = userId;
  $("bought").textContent = purchased;
  $("soldOutBadge").hidden = !soldOut;
  setPill($("stockPill"), soldOut ? "SOLD OUT" : "● LIVE", soldOut ? "bad" : "live");

  const pct = (n) => (data.total ? (100 * n) / data.total : 0);
  $("barSold").style.width = pct(data.sold) + "%";
  $("barHeld").style.width = pct(data.activeCount) + "%";
  $("barAvail").style.width = pct(data.available) + "%";

  // ---- reservation ----
  const cd = $("countdown");
  if (data.myReservation) {
    const left = data.myReservation.expiresAt - Date.now();
    $("holdBox").textContent = `Holding 1 pair — ${data.myReservation.id}. Complete checkout before the timer ends.`;
    cd.textContent = fmtCountdown(left);
    cd.classList.toggle("urgent", left < 60000);
    setPill($("holdPill"), pendingPayment ? "PAYMENT PENDING" : "HOLD ACTIVE", pendingPayment ? "warn" : "active");
  } else {
    $("holdBox").textContent = purchased >= 2
      ? "No active hold. You own the maximum of 2 pairs."
      : "No active hold.";
    cd.textContent = "–:––";
    cd.classList.remove("urgent");
    setPill($("holdPill"), "NO HOLD", "idle");
  }

  // ---- queue ----
  if (data.myQueue) {
    $("queueBox").innerHTML = `Position <strong>#${data.myQueue.position}</strong> of ${data.myQueue.total}`;
    setPill($("queuePill"), `IN LINE · #${data.myQueue.position}`, "active");
  } else if (data.myReservation && data.waitingCount > 0) {
    $("queueBox").textContent = "Allocated from the line — your hold has started.";
    setPill($("queuePill"), "ALLOCATED", "active");
  } else {
    $("queueBox").textContent = "Not in line.";
    setPill($("queuePill"), "NOT IN LINE", "idle");
  }

  // ---- orders: only backend-confirmed payments. One purchase = one order;
  // multiple rows are purchase history (max 2), never webhook duplicates. ----
  const orders = data.myOrders || [];
  $("orders").innerHTML = orders.length
    ? orders.map((o, i) => `<li><span>Pair ${i + 1} · <code>${o.id}</code></span><span class="paid-badge">PAID</span></li>`).join("")
    : `<li class="empty">No orders yet — completed purchases appear here.</li>`;
  $("ordersPill").textContent = `${orders.length} / 2`;

  // ---- pending fake-payment reconciliation (the fix: success only on backend proof) ----
  if (pendingPayment) {
    const done = orders.find((o) => o.reservation_id === pendingPayment.reservationId);
    if (done) {
      setFeedback($("payMsg"), `Payment confirmed — order ${done.id} · pair secured. No real money moved (simulation).`, "ok");
      pendingPayment = null;
    } else if (!data.myReservation) {
      setFeedback($("payMsg"), `Payment did not complete — the hold expired or was rejected before the callback arrived. No order created; no charge (simulation).`, "err");
      pendingPayment = null;
    } else {
      const waited = Math.round((Date.now() - pendingPayment.startedAt) / 1000);
      setFeedback($("payMsg"), `Waiting on the fake provider (${pendingPayment.scenario})… ${waited}s. Do not close — success shows only after backend confirmation.`, "info");
    }
  }

  // ---- action availability: disable what the current state forbids ----
  const buyBtn = $("buyBtn");
  const buyLabel = buyBtn.querySelector(".buy-label");
  const buySub = buyBtn.querySelector(".buy-sub");
  const atLimit = purchased >= 2;
  const busyHold = !!data.myReservation || !!pendingPayment;
  buyBtn.disabled = buying || busyHold || atLimit;
  buyBtn.classList.toggle("loading", buying);
  if (atLimit) {
    buyLabel.textContent = "LIMIT REACHED";
    buySub.textContent = "max 2 pairs per buyer";
    $("buyHint").textContent = "You own 2 pairs — the house limit. Thank you for playing fair.";
  } else if (data.myReservation || pendingPayment) {
    buyLabel.textContent = "HOLD IN PROGRESS";
    buySub.textContent = "pay or wait for expiry";
    $("buyHint").textContent = pendingPayment
      ? "Payment callback in flight — the result lands automatically."
      : "You already hold 1 pair. Checkout below, or let the 5:00 timer expire.";
  } else if (soldOut) {
    buyLabel.textContent = "JOIN WAITLIST";
    buySub.textContent = "sold out · take a number";
    $("buyHint").textContent = "Stock is out — Buy places you in the FIFO line.";
  } else {
    buyLabel.textContent = "BUY NOW";
    buySub.textContent = "hold 1 pair · 5 min";
    $("buyHint").textContent = "";
  }

  const canPay = !!data.myReservation && !pendingPayment && !paying;
  for (const b of payButtons()) {
    b.disabled = !canPay;
    b.classList.toggle("busy", paying);
  }

  $("joinBtn").disabled = joining || !!data.myQueue || !!data.myReservation || atLimit;
  $("leaveBtn").disabled = !data.myQueue;
}

function tick() {
  if (lastReservation) {
    const left = lastReservation.expiresAt - Date.now();
    const cd = $("countdown");
    cd.textContent = fmtCountdown(left);
    cd.classList.toggle("urgent", left < 60000 && left > 0);
    if (left <= 0) refresh();
  }
}

$("buyBtn").onclick = async () => {
  if (buying) return;
  buying = true;
  await refresh();
  try {
    const { ok, data } = await api("/api/buy", { method: "POST", body: JSON.stringify({ userId }) });
    if (ok && data.reserved) setFeedback($("msg"), "Pair held for 5:00. Head to checkout to simulate payment.", "ok");
    else if (ok && data.queued) setFeedback($("msg"), `Stock is out — you're #${data.queue.position} in line. Your hold starts automatically when a pair frees up.`, "info");
    else setFeedback($("msg"), `Could not buy: ${data.error}`, "err");
  } catch {
    setFeedback($("msg"), "Network error — please retry.", "err");
  }
  buying = false;
  refresh();
};

$("joinBtn").onclick = async () => {
  if (joining) return;
  joining = true;
  refresh();
  try {
    const { ok, data } = await api("/api/queue/join", { method: "POST", body: JSON.stringify({ userId }) });
    setFeedback($("msg"), ok && data.queue ? `In line at #${data.queue.position} of ${data.queue.total}.` : `Line: ${data.error || "done"}`, ok ? "info" : "err");
  } catch {
    setFeedback($("msg"), "Network error — please retry.", "err");
  }
  joining = false;
  refresh();
};

$("leaveBtn").onclick = async () => {
  await api("/api/queue/leave", { method: "POST", body: JSON.stringify({ userId }) });
  setFeedback($("msg"), "You left the line.", "info");
  refresh();
};

$("newUser").onclick = () => {
  userId = "user_" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("sneakdrop_user", userId);
  pendingPayment = null;
  setFeedback($("payMsg"), "", "");
  setFeedback($("msg"), "", "");
  refresh();
};

for (const btn of payButtons()) {
  btn.onclick = async () => {
    if (paying || pendingPayment) return; // prevent repeated clicks -> duplicate intents
    if (!lastReservation) {
      setFeedback($("payMsg"), "No active hold to pay for — click BUY NOW first.", "err");
      return;
    }
    paying = true;
    refresh();
    const scenario = btn.getAttribute("data-pay");
    const delayMs = scenario === "delayed" ? 8000 : undefined;
    const reservationId = lastReservation.id;
    try {
      const { ok, data } = await api("/api/pay", {
        method: "POST",
        body: JSON.stringify({ userId, reservationId, scenario, delayMs }),
      });
      if (ok) {
        pendingPayment = { paymentId: data.paymentId, reservationId, scenario, startedAt: Date.now() };
        setFeedback($("payMsg"), `Waiting on the fake provider (${scenario})… 0s. Do not close — success shows only after backend confirmation.`, "info");
      } else {
        setFeedback($("payMsg"), `Payment rejected: ${data.error}`, "err");
      }
    } catch {
      setFeedback($("payMsg"), "Network error — hold still active, safe to retry.", "err");
    }
    paying = false;
    refresh();
  };
}

refresh();
setInterval(refresh, 2000);
setInterval(tick, 500);
