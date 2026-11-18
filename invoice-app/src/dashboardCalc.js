// Pure calculation layer for the business dashboard — no D1, no fetch, no DOM, so it
// runs identically in the Worker and under plain `node` (see test-dashboard.js).
//
// Every rule here comes from BoJioVenue's own finance-rules.md (07_Claude/):
//   - A security deposit is the CLIENT'S money. It only touches the P&L if it is
//     forfeited/deducted — and then it is income.
//   - Cleaning fee collected is REVENUE, never netted against the cleaning contractor.
//   - A top-up invoiced after a forfeiture is income.
//   - Rent is NIL. There is no rent line, and nothing here estimates one.
//   - Equipment bought for the 2025 setup is CAPEX, not a monthly cost.
//   - Known gaps are STATED, never filled in: NULL means "not recorded" (different
//     from 0), and a month whose costs were never tracked is flagged, not zeroed.

import { isWeekend, SG_PUBLIC_HOLIDAYS } from "./pricing.js";

export const EXPENSE_CATEGORIES = [
  "Utilities",
  "Cleaning contractor",
  "Consumables & replacements",
  "Marketing / ad spend",
  "Platform commission",
  "Equipment (capex)",
  "Other",
];
export const CAPEX_CATEGORY = "Equipment (capex)";

// Which column of Carine's 'Monthly P&L' sheet each category lands in.
const COST_COLUMN = {
  "Utilities": "utilities",
  "Cleaning contractor": "contractor",
  "Consumables & replacements": "consumables",
  "Marketing / ad spend": "ads",
  "Platform commission": "platform",
  "Other": "other",
};
export const COST_COLUMNS = ["utilities", "contractor", "consumables", "ads", "platform", "other"];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = (v) => v !== null && v !== undefined && v !== "";
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const monthOf = (d) => String(d || "").slice(0, 7);
const groupBy = (arr, fn) => { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const sum = (arr, fn) => arr.reduce((s, x) => s + num(fn(x)), 0);

export function monthRange(startMonth, endMonth) {
  const out = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Weekdays strictly after `from`, up to and including `to` (UTC date maths, so the
// answer is identical in a Worker (UTC) and on a laptop in Singapore).
export function workingDaysBetween(from, to) {
  let n = 0;
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// name matching — the same booking is spelled differently across sources
// (say "Mark Ho" in the accounts but "Ho Wen Jie Mark" in the Lead Manager).
// ---------------------------------------------------------------------------
const STOP = new Set(["pte", "ltd", "private", "limited", "the", "and", "family", "birthday", "party", "mrs", "company", "incorporated", "inc", "sdn", "bhd", "llp", "friend"]);

export function nameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// Two names refer to the same person/company when they share enough significant
// words: 2 shared words, or all of them when one side only has one. This keeps two
// different families that merely share a surname ("Tan") apart.
export function sameName(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  const min = Math.min(ta.length, tb.length);
  if (min === 0) return false;
  const setA = new Set(ta);
  const shared = new Set(tb.filter((t) => setA.has(t))).size;
  return shared >= Math.min(2, min);
}

// Same booking = same event date AND the same person.
export function sameBooking(dateA, nameA, dateB, nameB) {
  return !!dateA && dateA === dateB && sameName(nameA, nameB);
}

// Rough Social/Corporate/Seminar label for rows that never recorded one. App bookings
// always carry a real event_type; this only ever runs on imported history, and the UI
// calls it "from the event description".
export function eventKind({ event_type, purpose, name }) {
  if (event_type && /^(social|corporate|seminar)$/i.test(event_type)) {
    const t = event_type.toLowerCase();
    return t[0].toUpperCase() + t.slice(1);
  }
  const text = `${purpose || ""} ${name || ""}`.toLowerCase();
  if (/seminar|workshop|training/.test(text)) return "Seminar";
  if (/\bpte\b|\bltd\b|limited|company|corporate|team\s*bond|incorporated|\bllp\b/.test(text)) return "Corporate";
  if (String(purpose || "").trim()) return "Social";
  return "Unspecified";
}

// ---------------------------------------------------------------------------
// bookings — one unified shape for invoice-app bookings and ledger (workbook) rows
// ---------------------------------------------------------------------------
export function buildBookings({ invoices = [], payments = [], deductions = [], ledger = [] }, today) {
  const paysByInv = groupBy(payments, (p) => p.invoice_id);
  const out = [];

  for (const inv of invoices) {
    if (inv.status === "void") continue;
    const pays = paysByInv.get(inv.id) || [];
    const cleaning = num(inv.cleaning_fee);
    const pet = num(inv.pet_fee);
    const revenue = round2(num(inv.grand_total)); // grand_total excludes the deposit by design
    const rental = round2(Math.max(0, revenue - cleaning - pet));
    const rentalLogged = sum(pays.filter((p) => p.kind === "balance"), (p) => p.amount);

    let collected = 0;
    if (inv.payment_status === "Paid") collected += rental + pet;
    else if (inv.payment_status === "Partially Paid") collected += Math.min(rental + pet, rentalLogged);
    if (inv.cleaning_fee_status === "Paid") collected += cleaning;
    collected = round2(collected);

    const signed = inv.status === "signed";
    const counted = signed || collected > 0 || inv.deposit_status !== "Not Collected";
    out.push({
      key: `inv:${inv.id}`,
      source: "app",
      booking_no: inv.booking_no,
      token: inv.token,
      client: inv.client_name,
      phone: inv.client_phone || null,
      email: inv.client_email || null,
      date: inv.booking_date,
      start_time: inv.start_time || null,
      end_time: inv.end_time || null,
      hours: num(inv.hours),
      kind: eventKind({ event_type: inv.event_type }),
      purpose: inv.notes || null,
      rental, cleaning, pet, extra: 0,
      revenue,
      deposit: num(inv.deposit_amount),
      collected,
      outstanding: counted ? round2(Math.max(0, revenue - collected)) : 0,
      paid_state: collected >= revenue - 0.005 && revenue > 0 ? "paid" : collected > 0 ? "partial" : "unpaid",
      state: signed ? "signed" : "awaiting",
      counted,
      discount: num(inv.discount),
      venue: inv.venue_space,
    });
  }

  for (const l of ledger) {
    if (l.status === "cancelled") continue;
    const rental = num(l.rental_fee), cleaning = num(l.cleaning_fee), pet = num(l.pet_fee);
    const extra = num(l.overtime) + num(l.topup);
    const revenue = round2(rental + cleaning + pet + extra);
    const paid = String(l.paid || "").toLowerCase();
    const collected = paid === "yes" ? revenue : 0;
    out.push({
      key: `led:${l.id}`,
      source: "ledger",
      booking_no: null,
      client: l.client_name,
      phone: null, email: null,
      date: l.event_date,
      start_time: null, end_time: null, hours: null,
      kind: eventKind({ event_type: l.event_type, purpose: l.purpose, name: l.client_name }),
      purpose: l.purpose || null,
      rental, cleaning, pet, extra,
      revenue,
      deposit: num(l.deposit_amount),
      collected,
      outstanding: round2(revenue - collected),
      paid_state: paid === "yes" ? "paid" : paid === "partial" ? "partial" : "unpaid",
      state: "recorded",
      counted: true,
      payment_mode: l.payment_mode || null,
      remarks: l.remarks || null,
      editable: l.source === "manual",
      row_id: l.id,
      discount: 0,
    });
  }

  // The same booking can exist in BOTH the app and the workbook (Carine back-fills
  // accounting.xlsx for bookings the app already holds). Count it once — prefer the
  // app record, which tracks real payments — and report the duplicates.
  const apps = out.filter((b) => b.source === "app" && b.counted);
  const duplicates = [];
  const kept = out.filter((b) => {
    if (b.source !== "ledger") return true;
    const dup = apps.find((a) => sameBooking(a.date, a.client, b.date, b.client));
    if (dup) { duplicates.push({ ledger: b.client, date: b.date, app: dup.booking_no }); return false; }
    return true;
  });
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { bookings: kept, duplicates };
}

// ---------------------------------------------------------------------------
// deposits — what was held, refunded, or retained
// ---------------------------------------------------------------------------
export function buildDeposits({ invoices = [], payments = [], deductions = [], ledgerDeposits = [], bookings = [] }, today) {
  const paysByInv = groupBy(payments, (p) => p.invoice_id);
  const dedByInv = groupBy(deductions, (d) => d.invoice_id);
  const rows = [];

  for (const inv of invoices) {
    if (inv.status === "void") continue;
    if (inv.deposit_status === "Not Collected") continue;
    const collected = num(inv.deposit_amount);
    const ded = (dedByInv.get(inv.id) || []);
    const retained = round2(sum(ded.filter((d) => d.status === "acknowledged"), (d) => d.amount));
    const pending = round2(sum(ded.filter((d) => d.status !== "acknowledged"), (d) => d.amount));
    const refundLogged = sum((paysByInv.get(inv.id) || []).filter((p) => p.kind === "refund"), (p) => p.amount);
    let status, refunded = 0;
    if (inv.deposit_status === "Refunded") {
      refunded = round2(refundLogged > 0 ? refundLogged : Math.max(0, collected - retained));
      status = retained <= 0 ? "refunded" : refunded > 0 ? "partial" : "forfeited";
    } else {
      status = "held";
    }
    rows.push({
      key: `inv:${inv.id}`, source: "app", booking_no: inv.booking_no,
      date: inv.booking_date, client: inv.client_name,
      collected, retained, refunded, topup: 0, status,
      pending_deduction: pending,
      evidence: ded.length ? ded.map((d) => d.reason).join("; ") : null,
      unverified: false,
    });
  }

  const appBookings = bookings.filter((b) => b.source === "app" && b.counted);
  const STATUS = { "refunded": "refunded", "partial refund": "partial", "forfeited": "forfeited", "pending": "held" };
  for (const l of ledgerDeposits) {
    if (appBookings.some((a) => sameBooking(a.date, a.client, l.event_date, l.client_name))) continue; // app has it
    const key = String(l.refund_status || "").trim().toLowerCase();
    rows.push({
      key: `ldep:${l.id}`, source: "ledger", booking_no: null,
      date: l.event_date, client: l.client_name,
      collected: num(l.deposit_collected),
      retained: num(l.deduction),
      refunded: num(l.refund_amount),
      topup: num(l.topup_invoiced),
      status: STATUS[key] || "held",
      pending_deduction: 0,
      evidence: l.evidence || null,
      unverified: /not individually documented|assumed/i.test(l.evidence || ""),
      editable: l.source === "manual",
      row_id: l.id,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return rows;
}

// ---------------------------------------------------------------------------
// calendar — every confirmed booking from every source, de-duplicated
// ---------------------------------------------------------------------------
export function buildCalendar({ bookings = [], imports = [] }, today) {
  const events = [];
  for (const b of bookings) {
    events.push({
      key: b.key, date: b.date, client: b.client,
      time: b.start_time && b.end_time ? `${b.start_time}–${b.end_time}` : null,
      hours: b.hours || null,
      kind: b.kind, purpose: b.purpose,
      state: b.state === "awaiting" ? "awaiting" : b.state === "signed" ? "signed" : "confirmed",
      source: b.source, priced: b.counted,
      revenue: b.counted ? b.revenue : null,
      phone: b.phone || null,
    });
  }
  for (const c of imports) {
    const covered = events.some((e) => sameBooking(e.date, e.client, c.event_date, c.client_name));
    if (covered) continue;
    events.push({
      key: `imp:${c.id}`, date: c.event_date, client: c.client_name,
      time: c.time_slot || null, hours: c.duration_hours || null,
      kind: eventKind({ purpose: c.purpose, name: c.client_name }), purpose: c.purpose || null,
      state: c.status === "Soft Book" ? "tentative" : "confirmed",
      source: "import", priced: false, revenue: null, phone: null,
    });
  }
  const byDate = groupBy(events.filter((e) => e.state !== "tentative"), (e) => e.date);
  for (const e of events) e.collision = (byDate.get(e.date) || []).length > 1 && e.state !== "tentative";
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

// ---------------------------------------------------------------------------
// clients — cluster every confirmed booking by person
// ---------------------------------------------------------------------------
export function buildClients(events, today) {
  const clusters = [];
  for (const e of events) {
    if (e.state === "tentative" || e.state === "awaiting") continue;
    let c = clusters.find((x) => x.names.some((n) => sameName(n, e.client)));
    if (!c) { c = { names: [], events: [] }; clusters.push(c); }
    if (!c.names.includes(e.client)) c.names.push(e.client);
    c.events.push(e);
  }
  const clients = clusters.map((c) => {
    const evs = c.events.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const past = evs.filter((e) => e.date <= today);
    const upcoming = evs.filter((e) => e.date > today);
    const display = c.names.slice().sort((a, b) => nameTokens(b).length - nameTokens(a).length)[0];
    const priced = evs.filter((e) => e.revenue !== null && e.revenue !== undefined);
    return {
      name: display,
      aliases: c.names.filter((n) => n !== display),
      bookings: evs.length,
      revenue: round2(sum(priced, (e) => e.revenue)),
      priced_count: priced.length,
      last: past.length ? past[past.length - 1].date : null,
      next: upcoming.length ? upcoming[0].date : null,
      repeat: evs.length > 1,
      kind: evs[evs.length - 1].kind,
      phone: (evs.slice().reverse().find((e) => e.phone) || {}).phone || null,
      events: evs.map((e) => ({ date: e.date, kind: e.kind, purpose: e.purpose, revenue: e.revenue, state: e.state, source: e.source })),
    };
  });
  clients.sort((a, b) => b.revenue - a.revenue || (a.name < b.name ? -1 : 1));
  return clients;
}

// ---------------------------------------------------------------------------
// monthly P&L — mirrors Carine's 'Monthly P&L' sheet column for column
// ---------------------------------------------------------------------------
export function buildMonths({ bookings = [], deposits = [], expenses = [], events = [] }, today) {
  const todayMonth = monthOf(today);
  const counted = bookings.filter((b) => b.counted && b.date <= today);
  const past = events.filter((e) => e.date <= today && (e.state === "signed" || e.state === "confirmed"));
  const costs = expenses.filter((e) => e.category !== CAPEX_CATEGORY);

  const all = [...counted.map((b) => b.date), ...deposits.filter((d) => d.date <= today).map((d) => d.date), ...past.map((e) => e.date), ...expenses.map((e) => e.expense_date)]
    .filter(Boolean).map(monthOf).filter((m) => m <= todayMonth).sort();
  const first = all.length ? all[0] : todayMonth;
  const firstCostMonth = costs.length ? costs.map((e) => monthOf(e.expense_date)).sort()[0] : null;

  return monthRange(first, todayMonth).map((month) => {
    const mb = counted.filter((b) => monthOf(b.date) === month);
    const md = deposits.filter((d) => monthOf(d.date) === month && d.date <= today);
    const me = past.filter((e) => monthOf(e.date) === month);
    const mc = costs.filter((e) => monthOf(e.expense_date) === month);

    const rental = round2(sum(mb, (b) => b.rental));
    const cleaning = round2(sum(mb, (b) => b.cleaning));
    // "Top-ups / other": pet fees, overtime, top-ups, AND deposits retained/forfeited
    // (income per finance-rules) plus top-ups invoiced after a forfeit.
    const retained = round2(sum(md, (d) => d.retained));
    const depTopup = round2(sum(md, (d) => d.topup));
    const topups = round2(sum(mb, (b) => b.pet + b.extra) + retained + depTopup);
    const revenue = round2(rental + cleaning + topups);

    const row = { month, bookings: me.length, priced: mb.length, unpriced: Math.max(0, me.length - mb.length), rental, cleaning, topups, retained, revenue };
    for (const c of COST_COLUMNS) row[c] = 0;
    for (const e of mc) row[COST_COLUMN[e.category] || "other"] = round2(row[COST_COLUMN[e.category] || "other"] + num(e.amount));
    row.cost = round2(sum(COST_COLUMNS, (c) => row[c]));
    row.net = round2(revenue - row.cost);
    // Before the first month any cost was written down, "0 cost" means "not tracked",
    // not "free" — so the net for that month is overstated and must say so.
    row.costs_recorded = firstCostMonth !== null && month >= firstCostMonth;
    row.estimated = mc.some((e) => e.is_estimate);
    return row;
  });
}

// ---------------------------------------------------------------------------
// data health — what is missing, stated plainly (never estimated)
// ---------------------------------------------------------------------------
export function buildHealth({ bookings = [], events = [], deposits = [], expenses = [], months = [], appInvoices = [], duplicates = [] }, today) {
  const items = [];
  const push = (it) => items.push(it);

  const unpriced = events.filter((e) => e.source === "import" && (e.state === "confirmed") && e.date <= today);
  if (unpriced.length) {
    const first = unpriced.map((e) => e.date).sort()[0];
    push({ id: "missing_amounts", level: "warn", count: unpriced.length,
      title: `${unpriced.length} confirmed booking${unpriced.length === 1 ? "" : "s"} have no amounts recorded`,
      detail: `These events are in the Lead Manager (earliest ${first}) but not in your accounts or the invoice app, so revenue after the last recorded booking is understated. Add them with “Record booking”.`,
      action: { label: "Record booking", do: "add-booking" } });
  }

  const firstCost = months.find((m) => m.costs_recorded);
  const before = months.filter((m) => !m.costs_recorded && m.revenue > 0);
  if (before.length) {
    push({ id: "costs_gap", level: "warn", count: before.length,
      title: firstCost ? `No costs recorded before ${firstCost.month}` : "No costs recorded yet",
      detail: `Profit for ${before.length} month${before.length === 1 ? "" : "s"} (${before[0].month} to ${before[before.length - 1].month}) is overstated — those costs were never written down and can't be reconstructed. Rent is genuinely nil.`,
      action: { label: "Add expense", do: "add-expense" } });
  }

  const est = expenses.filter((e) => num(e.is_estimate) === 1);
  if (est.length) {
    push({ id: "estimates", level: "info", count: est.length,
      title: `${est.length} expense${est.length === 1 ? " is" : "s are"} an estimate`,
      detail: `${est.map((e) => `${e.category} ${e.expense_date} ($${num(e.amount)})`).join(", ")} — replace with the real bill when you have it.` });
  }

  const unver = deposits.filter((d) => d.unverified);
  if (unver.length) {
    push({ id: "unverified_deposits", level: "info", count: unver.length,
      title: `${unver.length} deposit outcome${unver.length === 1 ? " rests" : "s rest"} on recollection`,
      detail: "Marked refunded from memory, not from a document. The amounts are assumed to be the full deposit." });
  }

  const overdue = deposits.filter((d) => d.source === "app" && d.status === "held" && workingDaysBetween(d.date, today) >= 5 && d.date <= today);
  if (overdue.length) {
    push({ id: "refund_overdue", level: "warn", count: overdue.length,
      title: `${overdue.length} deposit refund${overdue.length === 1 ? " is" : "s are"} overdue`,
      detail: `${overdue.map((d) => `${d.client} (${d.date})`).join(", ")} — the agreement promises 5 working days.` });
  }

  const unpaidPast = bookings.filter((b) => b.counted && b.outstanding > 0 && b.date <= today && b.source === "app");
  if (unpaidPast.length) {
    push({ id: "unpaid_past", level: "warn", count: unpaidPast.length,
      title: `${unpaidPast.length} past booking${unpaidPast.length === 1 ? " has" : "s have"} an unpaid balance`,
      detail: `$${round2(sum(unpaidPast, (b) => b.outstanding))} still to collect from events that have already happened.`,
      action: { label: "See who owes", do: "collect" } });
  }

  if (!expenses.some((e) => e.category === "Platform commission") && !expenses.some((e) => e.category === "Marketing / ad spend")) {
    push({ id: "no_platform_ads", level: "info",
      title: "No platform commission or ad spend recorded",
      detail: "Venuerific / TagVenue commission rates are unknown and Meta ad spend is unrecorded. If you pay either, real profit is lower than shown." });
  }
  if (!expenses.some((e) => e.category === CAPEX_CATEGORY)) {
    push({ id: "no_capex", level: "info",
      title: "Equipment (capex) isn't loaded",
      detail: "The 2025 setup (pool table, karaoke, arcade, chairs) is capital spend, not a monthly cost. Its paid amounts aren't reliably recorded yet, so payback can't be shown." });
  }
  if (duplicates.length) {
    push({ id: "duplicates", level: "info", count: duplicates.length,
      title: `${duplicates.length} accounting row${duplicates.length === 1 ? "" : "s"} also exist in the invoice app`,
      detail: "Counted once, from the app (which tracks real payments)." });
  }
  return items;
}

// ---------------------------------------------------------------------------
// the whole payload
// ---------------------------------------------------------------------------
export function buildDashboard(raw, today) {
  const { bookings, duplicates } = buildBookings(raw, today);
  const deposits = buildDeposits({ ...raw, bookings }, today);
  const calendar = buildCalendar({ bookings, imports: raw.imports || [] }, today);
  const clients = buildClients(calendar, today);
  const expenses = (raw.expenses || []).map((e) => ({
    id: e.id, date: e.expense_date, category: e.category, description: e.description, amount: num(e.amount),
    paid_by: e.paid_by || null, payment_method: e.payment_method || null, receipt_file: e.receipt_file || null,
    notes: e.notes || null, is_estimate: num(e.is_estimate) === 1, source: e.source, editable: e.source === "manual",
    capex: e.category === CAPEX_CATEGORY,
  }));
  const months = buildMonths({ bookings, deposits, expenses: raw.expenses || [], events: calendar }, today);
  const health = buildHealth({ bookings, events: calendar, deposits, expenses: raw.expenses || [], months, duplicates }, today);

  const owed = bookings.filter((b) => b.counted && b.outstanding > 0 && b.source === "app");
  const held = deposits.filter((d) => d.status === "held");
  const ahead = bookings.filter((b) => b.counted && b.date > today);
  const summary = {
    to_collect: round2(sum(owed, (b) => b.outstanding)), to_collect_count: owed.length,
    held_deposits: round2(sum(held, (d) => d.collected)), held_count: held.length,
    booked_ahead: round2(sum(ahead, (b) => b.revenue)), booked_ahead_count: ahead.length,
    upcoming_events: calendar.filter((e) => e.date >= today && e.state !== "tentative").length,
    capex_total: round2(sum(expenses.filter((e) => e.capex), (e) => e.amount)),
  };
  const holidays = [...SG_PUBLIC_HOLIDAYS];
  return { today, bookings, deposits, expenses, calendar, clients, months, health, summary, holidays };
}

export { isWeekend };
