// Business dashboard API — everything under /api/dashboard/*. The router in worker.js
// only calls this AFTER the shared Bearer-ADMIN_KEY check, so nothing here re-checks
// auth. All money logic lives in dashboardCalc.js (pure, unit-tested); this file only
// reads D1, validates input and shapes responses.
//
//   GET    /api/dashboard/data                  everything the dashboard renders
//   POST   /api/dashboard/expenses              add an expense
//   PUT    /api/dashboard/expenses/:id          edit a hand-entered expense
//   DELETE /api/dashboard/expenses/:id          delete a hand-entered expense
//   POST   /api/dashboard/ledger-bookings       record a booking made outside the app
//   DELETE /api/dashboard/ledger-bookings/:id   delete a hand-entered booking record
//   GET    /api/dashboard/templates             WhatsApp message wordings
//   PUT    /api/dashboard/templates/:key        edit one
//   GET    /api/dashboard/export/:kind          CSV: bookings | expenses | deposits | pnl
//
// "One owner per row": rows imported from a workbook (source LIKE 'import:%') are
// read-only here — fix them in the workbook and re-run scripts/import_finance.py.
// Only source = 'manual' rows can be edited or deleted from the dashboard.

import { buildDashboard, EXPENSE_CATEGORIES } from "./dashboardCalc.js";
import { listMessageTemplates, setMessageTemplate } from "./db.js";

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const fail = (message, status = 400) => reply({ error: message }, status);

// Singapore calendar date (UTC+8). The Worker runs in UTC, so "today" must be shifted
// or a booking at 1am SGT would be filed under yesterday.
export const sgToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const TEMPLATE_KEYS = ["agreement_send", "after_sign_payment", "booking_confirmed"];

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------
async function rows(env, sql, warnings, label) {
  try {
    const { results } = await env.DB.prepare(sql).all();
    return results || [];
  } catch (e) {
    // A table the deploy hasn't created yet must not take the whole dashboard down.
    warnings.push(`${label}: ${String((e && e.message) || e).replace(/^D1_ERROR: /, "")}`);
    return [];
  }
}

export async function loadDashboard(env) {
  const warnings = [];
  const [invoices, payments, deductions, ledger, ledgerDeposits, expenses, imports] = await Promise.all([
    // explicit columns — never SELECT * from invoices: signature_png is a large base64 image
    rows(env, `SELECT id, booking_no, token, status, client_name, client_phone, client_email, event_type, venue_space,
                      booking_date, start_time, end_time, hours, grand_total, cleaning_fee, pet_fee, deposit_amount,
                      discount, payment_status, cleaning_fee_status, deposit_status, notes
               FROM invoices`, warnings, "invoices"),
    rows(env, `SELECT invoice_id, amount, kind, paid_on, payment_mode, bank, reference FROM payments`, warnings, "payments"),
    rows(env, `SELECT invoice_id, amount, reason, status, acknowledged_at FROM deductions`, warnings, "deductions"),
    rows(env, `SELECT * FROM ledger_bookings`, warnings, "ledger_bookings"),
    rows(env, `SELECT * FROM ledger_deposits`, warnings, "ledger_deposits"),
    rows(env, `SELECT * FROM expenses ORDER BY expense_date DESC, id DESC`, warnings, "expenses"),
    rows(env, `SELECT * FROM calendar_imports`, warnings, "calendar_imports"),
  ]);

  const today = sgToday();
  const data = buildDashboard({ invoices, payments, deductions, ledger, ledgerDeposits, expenses, imports }, today);

  const lastImport = [ledger, ledgerDeposits, expenses, imports]
    .flat().filter((r) => String(r.source || "").startsWith("import:")).map((r) => r.created_at).sort().pop() || null;

  return {
    ...data,
    generated_at: new Date().toISOString(),
    categories: EXPENSE_CATEGORIES,
    sources: {
      app_invoices: invoices.length, ledger_bookings: ledger.length, ledger_deposits: ledgerDeposits.length,
      expenses: expenses.length, calendar_imports: imports.length, last_import: lastImport,
    },
    business: {
      name: env.BUSINESS_NAME || "BoJioVenue", entity: env.BUSINESS_ENTITY || "", operator: env.BUSINESS_OPERATOR || "",
      uen: env.BUSINESS_UEN || "", phone: env.BUSINESS_PHONE || "", email: env.BUSINESS_EMAIL || "",
      address: env.BUSINESS_ADDRESS || "", house_rules_url: env.HOUSE_RULES_URL || "", public_base_url: env.PUBLIC_BASE_URL || "",
      telegram_bot: "BojioVenueInvoiceBot",
    },
    setup_warnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
const str = (v, max) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const money = (v) => {
  if (v === null || v === undefined || v === "") return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return { error: true };
  return { value: Math.round(n * 100) / 100 };
};

function parseExpense(b) {
  const date = String(b.date || "").trim();
  if (!validDate(date)) return { error: "Date must be a real date like 2026-11-18." };
  if (!EXPENSE_CATEGORIES.includes(b.category)) return { error: "Pick a category from the list." };
  const description = str(b.description, 200);
  if (!description) return { error: "Add a short description." };
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return { error: "Amount must be a positive number." };
  return { value: {
    date, category: b.category, description, amount: Math.round(amount * 100) / 100,
    paid_by: str(b.paid_by, 60), payment_method: str(b.payment_method, 60), receipt_file: str(b.receipt_file, 200),
    notes: str(b.notes, 500), is_estimate: b.is_estimate ? 1 : 0,
  } };
}

function parseLedgerBooking(b) {
  const date = String(b.event_date || "").trim();
  if (!validDate(date)) return { error: "Event date must be a real date like 2026-08-15." };
  const client = str(b.client_name, 120);
  if (!client) return { error: "Add the client's name." };
  const v = { event_date: date, client_name: client };
  for (const k of ["rental_fee", "cleaning_fee", "pet_fee", "overtime", "topup", "deposit_amount"]) {
    const m = money(b[k]);
    if (m.error) return { error: `${k.replace(/_/g, " ")} must be a number of dollars (0 or more).` };
    v[k] = m.value;
  }
  const paid = String(b.paid || "yes").toLowerCase();
  if (!["yes", "no", "partial"].includes(paid)) return { error: "Paid must be yes, no or partial." };
  v.paid = paid;
  v.purpose = str(b.purpose, 120); v.payment_mode = str(b.payment_mode, 60); v.remarks = str(b.remarks, 500);
  v.event_type = ["Social", "Corporate", "Seminar"].includes(b.event_type) ? b.event_type : null;
  v.total_invoiced = Math.round(["rental_fee", "cleaning_fee", "pet_fee", "overtime", "topup", "deposit_amount"].reduce((s, k) => s + (v[k] || 0), 0) * 100) / 100;
  return { value: v };
}

async function manualRowOrError(env, table, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { res: fail("Bad id.") };
  const row = await env.DB.prepare(`SELECT id, source FROM ${table} WHERE id = ?`).bind(n).first();
  if (!row) return { res: fail("Not found.", 404) };
  if (row.source !== "manual") {
    return { res: fail("This row was imported from a workbook, so it's edited there. Update the workbook and re-run the import.", 403) };
  }
  return { id: n };
}

// ---------------------------------------------------------------------------
// CSV (spreadsheet-safe: a client name like "=HYPERLINK(...)" must not become a formula)
// ---------------------------------------------------------------------------
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (header, lines) => "﻿" + [header, ...lines].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

function exportCsv(kind, d) {
  const yn = (b) => (b ? "yes" : "no");
  if (kind === "bookings") {
    return csv(["Event date", "Client", "Booking no.", "Source", "Type", "Rental", "Cleaning", "Pet fee", "Other income", "Revenue", "Deposit", "Collected", "Outstanding", "Payment"],
      d.bookings.map((b) => [b.date, b.client, b.booking_no, b.source === "app" ? "Invoice app" : "Accounts", b.kind, b.rental, b.cleaning, b.pet, b.extra, b.revenue, b.deposit, b.collected, b.outstanding, b.paid_state]));
  }
  if (kind === "expenses") {
    return csv(["Date", "Category", "Description", "Amount", "Paid by", "Payment method", "Receipt file", "Notes", "Estimate"],
      d.expenses.map((e) => [e.date, e.category, e.description, e.amount, e.paid_by, e.payment_method, e.receipt_file, e.notes, yn(e.is_estimate)]));
  }
  if (kind === "deposits") {
    return csv(["Event date", "Client", "Deposit collected", "Retained (income)", "Refunded", "Top-up invoiced", "Status", "Evidence"],
      d.deposits.map((x) => [x.date, x.client, x.collected, x.retained, x.refunded, x.topup, x.status, x.evidence]));
  }
  if (kind === "pnl") {
    // Column-for-column with Carine's 'Monthly P&L' sheet in expenses-2026.xlsx.
    return csv(["Month", "Bookings", "Rental revenue", "Cleaning collected", "Top-ups / other", "TOTAL REVENUE", "Utilities", "Cleaning contractor", "Consumables", "Ad spend", "Platform fees", "Other", "TOTAL COST", "NET", "Costs recorded"],
      d.months.map((m) => [m.month, m.bookings, m.rental, m.cleaning, m.topups, m.revenue, m.utilities, m.contractor, m.consumables, m.ads, m.platform, m.other, m.cost, m.net, yn(m.costs_recorded)]));
  }
  return null;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
export async function dashboardApi(env, parts, method, request) {
  const [resource, id] = parts;
  const body = async () => { try { return await request.json(); } catch { return null; } };

  if (resource === "data" && method === "GET") return reply(await loadDashboard(env));

  if (resource === "export" && method === "GET") {
    const out = exportCsv(id, await loadDashboard(env));
    if (out === null) return fail("Unknown export.", 404);
    return new Response(out, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (resource === "expenses") {
    if (method === "POST") {
      const b = await body(); if (!b) return fail("Send JSON.");
      const p = parseExpense(b); if (p.error) return fail(p.error);
      const v = p.value;
      const r = await env.DB.prepare(
        `INSERT INTO expenses (expense_date, category, description, amount, paid_by, payment_method, receipt_file, notes, is_estimate, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
      ).bind(v.date, v.category, v.description, v.amount, v.paid_by, v.payment_method, v.receipt_file, v.notes, v.is_estimate).run();
      return reply({ ok: true, id: r.meta && r.meta.last_row_id }, 201);
    }
    if (method === "PUT" || method === "DELETE") {
      const own = await manualRowOrError(env, "expenses", id); if (own.res) return own.res;
      if (method === "DELETE") { await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(own.id).run(); return reply({ ok: true }); }
      const b = await body(); if (!b) return fail("Send JSON.");
      const p = parseExpense(b); if (p.error) return fail(p.error);
      const v = p.value;
      await env.DB.prepare(
        `UPDATE expenses SET expense_date=?, category=?, description=?, amount=?, paid_by=?, payment_method=?, receipt_file=?, notes=?, is_estimate=? WHERE id=?`
      ).bind(v.date, v.category, v.description, v.amount, v.paid_by, v.payment_method, v.receipt_file, v.notes, v.is_estimate, own.id).run();
      return reply({ ok: true });
    }
  }

  if (resource === "ledger-bookings") {
    if (method === "POST") {
      const b = await body(); if (!b) return fail("Send JSON.");
      const p = parseLedgerBooking(b); if (p.error) return fail(p.error);
      const v = p.value;
      const r = await env.DB.prepare(
        `INSERT INTO ledger_bookings (event_date, client_name, purpose, event_type, rental_fee, cleaning_fee, pet_fee, overtime, topup, deposit_amount, total_invoiced, paid, payment_mode, remarks, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'manual')`
      ).bind(v.event_date, v.client_name, v.purpose, v.event_type, v.rental_fee, v.cleaning_fee, v.pet_fee, v.overtime, v.topup, v.deposit_amount, v.total_invoiced, v.paid, v.payment_mode, v.remarks).run();
      return reply({ ok: true, id: r.meta && r.meta.last_row_id }, 201);
    }
    if (method === "DELETE") {
      const own = await manualRowOrError(env, "ledger_bookings", id); if (own.res) return own.res;
      await env.DB.prepare(`DELETE FROM ledger_bookings WHERE id = ?`).bind(own.id).run();
      return reply({ ok: true });
    }
  }

  if (resource === "templates") {
    if (method === "GET") return reply({ templates: await listMessageTemplates(env) });
    if (method === "PUT" && TEMPLATE_KEYS.includes(id)) {
      const b = await body(); const text = b && str(b.body, 1000);
      if (!text) return fail("The message can't be empty.");
      await setMessageTemplate(env, id, text);
      return reply({ ok: true });
    }
  }

  return fail("Not found.", 404);
}
