// Regression tests for src/dashboardCalc.js — plain Node `assert`, no framework.
//   node test-dashboard.js
//
// Names below are INVENTED: this repo is public, so no real client data belongs in a
// test. The shapes mirror real edge cases found in BoJioVenue's workbooks — one
// booking spelled two ways across sources, two families sharing only a surname, a
// deposit that must not count as revenue, months whose costs were never tracked.

import assert from "node:assert/strict";
import {
  sameName, sameBooking, eventKind, workingDaysBetween, monthRange,
  buildBookings, buildDeposits, buildCalendar, buildClients, buildMonths, buildHealth, buildDashboard,
} from "./src/dashboardCalc.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}
const TODAY = "2026-11-18";

// ---------------------------------------------------------------------------
// name matching
// ---------------------------------------------------------------------------
test("sameName: one person spelled two ways across sources", () => {
  assert.equal(sameName("Daniel Koh", "Koh Wei Ming Daniel"), true);
});
test("sameName: a short name matches when its only real word is shared", () => {
  assert.equal(sameName("Mark Ho", "Ho Wen Jie Mark"), true); // 'ho' is too short to count; 'mark' is shared
});
test("sameName: two families sharing only a surname stay apart", () => {
  assert.equal(sameName("Priya Nair", "Nair Anita"), false);
  assert.equal(sameName("Chua Hock Seng", "Chua Bee Lian (Lily)"), false);
});
test("sameName: company names with legal suffixes", () => {
  assert.equal(sameName("Acme Robotics Pte Ltd", "Robotics Acme (Samuel)"), true);
});
test("sameBooking: needs the SAME date as well as the same person", () => {
  assert.equal(sameBooking("2026-10-03", "Daniel Koh", "2026-10-03", "Koh Wei Ming Daniel"), true);
  assert.equal(sameBooking("2026-10-03", "Daniel Koh", "2026-10-04", "Koh Wei Ming Daniel"), false);
});
test("eventKind: uses a real event_type when present, else reads the description", () => {
  assert.equal(eventKind({ event_type: "corporate" }), "Corporate");
  assert.equal(eventKind({ purpose: "Seminar (Main Hall)" }), "Seminar");
  assert.equal(eventKind({ purpose: "Christmas Party", name: "Acme Pte Ltd" }), "Corporate");
  assert.equal(eventKind({ purpose: "21st Birthday", name: "Mia Lee" }), "Social");
  assert.equal(eventKind({ name: "Priscilla" }), "Unspecified");
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
test("workingDaysBetween: Friday to the next Friday is 5 working days", () => {
  assert.equal(workingDaysBetween("2026-11-06", "2026-11-13"), 5);
  assert.equal(workingDaysBetween("2026-11-13", "2026-11-16"), 1); // Fri -> Mon
});
test("monthRange: crosses a year boundary", () => {
  assert.deepEqual(monthRange("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

// ---------------------------------------------------------------------------
// bookings
// ---------------------------------------------------------------------------
const inv = (o) => ({
  id: 1, booking_no: "2026041", token: "t", status: "signed", client_name: "Mia Lee", client_phone: "91234567",
  booking_date: "2026-10-10", hours: 6, event_type: "Social", venue_space: "Whole Venue",
  grand_total: 740, cleaning_fee: 80, pet_fee: 0, deposit_amount: 500, discount: 0,
  payment_status: "Paid", cleaning_fee_status: "Unpaid", deposit_status: "Held", ...o,
});

test("app booking: revenue excludes the deposit; cleaning is revenue", () => {
  const { bookings } = buildBookings({ invoices: [inv()] }, TODAY);
  const b = bookings[0];
  assert.equal(b.revenue, 740);       // grand_total, deposit NOT included
  assert.equal(b.cleaning, 80);       // cleaning counted as revenue
  assert.equal(b.rental, 660);
  assert.equal(b.deposit, 500);
});
test("app booking: rental paid but cleaning unpaid leaves exactly the cleaning fee outstanding", () => {
  const b = buildBookings({ invoices: [inv()] }, TODAY).bookings[0];
  assert.equal(b.collected, 660);
  assert.equal(b.outstanding, 80);
  assert.equal(b.paid_state, "partial");
});
test("app booking: void bookings are ignored; an unsigned, unpaid one is not counted as revenue", () => {
  const { bookings } = buildBookings({ invoices: [
    inv({ id: 1, status: "void" }),
    inv({ id: 2, status: "issued", payment_status: "Unpaid", deposit_status: "Not Collected" }),
  ] }, TODAY);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].counted, false);
  assert.equal(bookings[0].outstanding, 0); // pipeline, not money owed yet
});
test("ledger booking: components sum to revenue and exclude the deposit", () => {
  const { bookings } = buildBookings({ ledger: [{ id: 1, event_date: "2026-01-10", client_name: "Sam Ong", rental_fee: 800, cleaning_fee: 100, pet_fee: 0, overtime: 0, deposit_amount: 500, paid: "yes", source: "import:x" }] }, TODAY);
  assert.equal(bookings[0].revenue, 900);
  assert.equal(bookings[0].collected, 900);
  assert.equal(bookings[0].outstanding, 0);
});
test("ledger booking: NULL amounts mean 'not recorded' and never crash", () => {
  const { bookings } = buildBookings({ ledger: [{ id: 1, event_date: "2026-01-10", client_name: "Sam Ong", paid: "no" }] }, TODAY);
  assert.equal(bookings[0].revenue, 0);
});
test("dedupe: a workbook row that also exists in the app is counted once, from the app", () => {
  const { bookings, duplicates } = buildBookings({
    invoices: [inv()],
    ledger: [{ id: 9, event_date: "2026-10-10", client_name: "Lee Mia", rental_fee: 660, cleaning_fee: 80, paid: "yes", source: "import:x" }],
  }, TODAY);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].source, "app");
  assert.equal(duplicates.length, 1);
});

// ---------------------------------------------------------------------------
// deposits
// ---------------------------------------------------------------------------
test("deposits (app): refunded with an acknowledged deduction is a PARTIAL refund, retained amount is income", () => {
  const invoices = [inv({ deposit_status: "Refunded" })];
  const deductions = [{ invoice_id: 1, amount: 150, reason: "stained sofa", status: "acknowledged" }];
  const rows = buildDeposits({ invoices, deductions, bookings: [] }, TODAY);
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].retained, 150);
  assert.equal(rows[0].refunded, 350);
});
test("deposits (app): a deduction not yet acknowledged is pending, not retained", () => {
  const rows = buildDeposits({ invoices: [inv({ deposit_status: "Held" })], deductions: [{ invoice_id: 1, amount: 100, reason: "x", status: "pending" }], bookings: [] }, TODAY);
  assert.equal(rows[0].retained, 0);
  assert.equal(rows[0].pending_deduction, 100);
});
test("deposits (ledger): statuses map, forfeits are income, 'not individually documented' is flagged", () => {
  const ledgerDeposits = [
    { id: 1, event_date: "2026-09-01", client_name: "A One", deposit_collected: 500, deduction: 0, refund_amount: 500, refund_status: "Refunded", evidence: "Per Kenneth — not individually documented" },
    { id: 2, event_date: "2026-09-02", client_name: "B Two", deposit_collected: 500, deduction: 430, refund_amount: 70, refund_status: "Partial refund", evidence: "$430 forfeited; separate $250 top-up invoiced", topup_invoiced: 250 },
    { id: 3, event_date: "2026-09-03", client_name: "C Three", deposit_collected: 500, deduction: 500, refund_amount: 0, refund_status: "Forfeited" },
  ];
  const rows = buildDeposits({ ledgerDeposits, bookings: [] }, TODAY).reverse();
  assert.deepEqual(rows.map((r) => r.status), ["refunded", "partial", "forfeited"]);
  assert.equal(rows[0].unverified, true);
  assert.equal(rows[1].topup, 250);
});

// ---------------------------------------------------------------------------
// monthly P&L
// ---------------------------------------------------------------------------
test("P&L: a deposit is NOT revenue, but a forfeit and a top-up ARE (finance-rules)", () => {
  const { bookings } = buildBookings({ ledger: [{ id: 1, event_date: "2026-10-05", client_name: "Sam Ong", rental_fee: 600, cleaning_fee: 80, deposit_amount: 500, paid: "yes", source: "import:x" }] }, TODAY);
  const deposits = buildDeposits({ ledgerDeposits: [{ id: 1, event_date: "2026-10-05", client_name: "Sam Ong", deposit_collected: 500, deduction: 430, refund_amount: 70, refund_status: "Partial refund", topup_invoiced: 250 }], bookings }, TODAY);
  const m = buildMonths({ bookings, deposits, expenses: [], events: [] }, TODAY).find((x) => x.month === "2026-10");
  assert.equal(m.rental, 600);
  assert.equal(m.cleaning, 80);            // cleaning is revenue
  assert.equal(m.retained, 430);
  assert.equal(m.topups, 430 + 250);       // forfeit + top-up
  assert.equal(m.revenue, 600 + 80 + 680); // the $500 deposit itself is nowhere in here
});
test("P&L: capex never lands in the monthly cost; cost categories land in Carine's columns", () => {
  const expenses = [
    { expense_date: "2026-10-31", category: "Cleaning contractor", amount: 110, is_estimate: 0 },
    { expense_date: "2026-10-31", category: "Utilities", amount: 300, is_estimate: 1 },
    { expense_date: "2026-10-12", category: "Equipment (capex)", amount: 2000, is_estimate: 0 },
  ];
  const m = buildMonths({ bookings: [], deposits: [], expenses, events: [] }, TODAY).find((x) => x.month === "2026-10");
  assert.equal(m.contractor, 110);
  assert.equal(m.utilities, 300);
  assert.equal(m.cost, 410);               // capex excluded
  assert.equal(m.estimated, true);
});
test("P&L: months before any cost was tracked are flagged, never silently shown as zero-cost profit", () => {
  const { bookings } = buildBookings({ ledger: [
    { id: 1, event_date: "2026-05-09", client_name: "Sam Ong", rental_fee: 640, cleaning_fee: 100, paid: "yes", source: "import:x" },
    { id: 2, event_date: "2026-10-20", client_name: "Mia Lee", rental_fee: 700, cleaning_fee: 80, paid: "yes", source: "import:x" },
  ] }, TODAY);
  const months = buildMonths({ bookings, deposits: [], expenses: [{ expense_date: "2026-10-31", category: "Utilities", amount: 300 }], events: [] }, TODAY);
  assert.equal(months.find((m) => m.month === "2026-05").costs_recorded, false);
  assert.equal(months.find((m) => m.month === "2026-10").costs_recorded, true);
  const health = buildHealth({ bookings, months, expenses: [{ expense_date: "2026-10-31", category: "Utilities", amount: 300 }] }, TODAY);
  assert.ok(health.some((h) => h.id === "costs_gap"));
});
test("P&L: future-dated bookings are 'booked ahead', not this month's revenue", () => {
  const { bookings } = buildBookings({ ledger: [{ id: 1, event_date: "2026-12-12", client_name: "Sam Ong", rental_fee: 800, cleaning_fee: 80, paid: "yes", source: "import:x" }] }, TODAY);
  const d = buildDashboard({ ledger: [{ id: 1, event_date: "2026-12-12", client_name: "Sam Ong", rental_fee: 800, cleaning_fee: 80, paid: "yes", source: "import:x" }] }, TODAY);
  assert.equal(d.months.every((m) => m.month <= "2026-11"), true);
  assert.equal(d.summary.booked_ahead, 880);
  assert.equal(bookings.length, 1);
});

// ---------------------------------------------------------------------------
// calendar, clients, health
// ---------------------------------------------------------------------------
test("calendar: a Lead Manager booking already in the accounts isn't shown twice", () => {
  const { bookings } = buildBookings({ ledger: [{ id: 1, event_date: "2026-03-14", client_name: "Daniel Koh", rental_fee: 640, cleaning_fee: 100, paid: "yes", source: "import:x" }] }, TODAY);
  const cal = buildCalendar({ bookings, imports: [{ id: 1, event_date: "2026-03-14", client_name: "Koh Wei Ming Daniel", status: "Confirmed" }] }, TODAY);
  assert.equal(cal.length, 1);
});
test("calendar: two confirmed bookings on one date are flagged as a collision; a soft book is not", () => {
  const cal = buildCalendar({ bookings: [], imports: [
    { id: 1, event_date: "2026-12-19", client_name: "Orson One", status: "Confirmed" },
    { id: 2, event_date: "2026-12-19", client_name: "Helen Two", status: "Confirmed" },
    { id: 3, event_date: "2026-12-20", client_name: "Ivan Three", status: "Confirmed" },
    { id: 4, event_date: "2026-12-20", client_name: "June Four", status: "Soft Book" },
  ] }, TODAY);
  assert.equal(cal.filter((e) => e.date === "2026-12-19").every((e) => e.collision), true);
  assert.equal(cal.filter((e) => e.date === "2026-12-20").some((e) => e.collision), false);
});
test("health: confirmed past bookings with no amounts anywhere are counted — the known gap is measured, not hardcoded", () => {
  const events = buildCalendar({ bookings: [], imports: [
    { id: 1, event_date: "2026-08-01", client_name: "Orson One", status: "Confirmed" },
    { id: 2, event_date: "2026-09-01", client_name: "Helen Two", status: "Confirmed" },
    { id: 3, event_date: "2027-01-01", client_name: "Ivan Three", status: "Confirmed" }, // future: not a gap
  ] }, TODAY);
  const h = buildHealth({ events }, TODAY).find((x) => x.id === "missing_amounts");
  assert.equal(h.count, 2);
});
test("health: a held deposit 5+ working days past the event is flagged overdue", () => {
  const deposits = buildDeposits({ invoices: [inv({ booking_date: "2026-11-02", deposit_status: "Held" })], bookings: [] }, TODAY);
  const h = buildHealth({ deposits }, TODAY);
  assert.ok(h.some((x) => x.id === "refund_overdue"));
});
test("clients: repeat customers are clustered across spellings and sources; surname-only matches stay separate", () => {
  const events = buildCalendar({ bookings: [], imports: [
    { id: 1, event_date: "2026-01-10", client_name: "Daniel Koh", status: "Confirmed" },
    { id: 2, event_date: "2026-06-12", client_name: "Koh Wei Ming Daniel", status: "Confirmed" },
    { id: 3, event_date: "2026-07-01", client_name: "Priya Nair", status: "Confirmed" },
    { id: 4, event_date: "2026-08-01", client_name: "Nair Anita", status: "Confirmed" },
  ] }, TODAY);
  const clients = buildClients(events, TODAY);
  assert.equal(clients.length, 3);
  const daniel = clients.find((c) => c.name.includes("Daniel"));
  assert.equal(daniel.bookings, 2);
  assert.equal(daniel.repeat, true);
  assert.equal(daniel.name, "Koh Wei Ming Daniel"); // the fuller spelling wins as display name
});
test("dashboard: an empty database yields a valid, empty payload (no crash on day one)", () => {
  const d = buildDashboard({}, TODAY);
  assert.equal(d.bookings.length, 0);
  assert.equal(d.months.length, 1);
  assert.equal(d.summary.to_collect, 0);
});

console.log(`${passed} test(s) passed.`);
if (process.exitCode) console.error("Some tests FAILED — see above."); else console.log("All tests passed.");
