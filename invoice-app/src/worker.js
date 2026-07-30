// BojioVenue Worker — router + request handlers.
//
// Routes
//   GET  /                         -> admin UI (key-gated in the browser)
//   GET  /admin                    -> admin UI
//   GET  /sign/:token              -> public signing page (shows the Agreement)
//   GET  /api/sign/:token          -> public: booking + agreement data for the signing page
//   POST /api/sign/:token          -> public: submit signature -> Agreement + 2 Invoice PDFs -> Drive -> notify
//   POST /telegram/webhook         -> Telegram bot inbound: create an invoice from a templated message
//                                      (restricted to Kenneth's own chat_id — see TELEGRAM_CHAT_ID)
//   --- everything below requires  Authorization: Bearer <ADMIN_KEY> ---
//   POST /api/invoices             -> create + issue an invoice (assigns INV-###)
//   GET  /api/invoices             -> list
//   GET  /api/invoices/:no         -> one invoice + payments
//   POST /api/invoices/:no/payments-> log a payment
//   POST /api/invoices/:no/status  -> set payment/cleaning/deposit status
//   POST /api/invoices/:no/refile  -> regenerate the 3 PDFs + re-upload to Drive
//   POST /api/invoices/:no/void    -> void (keeps the number)

import * as db from "./db.js";
import { computeQuote, parseDiscount, EVENT_TYPES, VENUE_SPACES } from "./pricing.js";
import { buildBookingInvoicePdf, buildDepositInvoicePdf } from "./pdf.js";
import { agreementHtml, buildAgreementPdf } from "./agreement.js";
import { fileToDrive } from "./drive.js";
import { notifySigned, sendTelegram } from "./notify.js";
import { adminPage, signPage } from "./pages.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const html = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ['api','invoices','INV-001','void']
    const method = request.method;

    try {
      // ---- Public: signing page + its API -------------------------------
      if (parts[0] === "sign" && parts[1]) return html(signPage(env, parts[1]));

      if (parts[0] === "api" && parts[1] === "sign" && parts[2]) {
        if (method === "GET") return getSignData(env, parts[2]);
        if (method === "POST") return submitSignature(env, ctx, parts[2], request);
        return json({ error: "method not allowed" }, 405);
      }

      // ---- Telegram inbound webhook --------------------------------------
      if (parts[0] === "telegram" && parts[1] === "webhook" && method === "POST") {
        return telegramWebhook(env, request);
      }

      // ---- Admin UI -----------------------------------------------------
      if (parts.length === 0 || parts[0] === "admin") return html(adminPage(env));

      // ---- Admin API (key-gated) ---------------------------------------
      if (parts[0] === "api") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) return json({ error: "unauthorized" }, 401);
        return adminApi(env, parts, method, request);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.log("ERROR", err && (err.stack || err.message || err));
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Public signing
// ---------------------------------------------------------------------------
async function getSignData(env, token) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  // Only expose what the signing page needs — no phone/full payment history.
  const safe = {
    invoice_no: inv.invoice_no, status: inv.status, client_name: inv.client_name,
    event_type: inv.event_type, venue_space: inv.venue_space, booking_date: inv.booking_date,
    grand_total: inv.grand_total, deposit_amount: inv.deposit_amount,
    agreement_title: inv.venue_space === "Main Hall Only" ? "Seminar / Training Room Rental Agreement" : "Event Space Rental Agreement",
    agreement_html: agreementHtml(env, inv),
  };
  return json({ invoice: safe });
}

async function submitSignature(env, ctx, token, request) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  if (inv.status === "void") return json({ error: "This invoice has been cancelled." }, 410);
  if (inv.status === "signed") return json({ error: "Already signed.", already: true }, 409);

  const body = await request.json().catch(() => ({}));
  if (!body.signature_png || !body.signer_name) return json({ error: "Signature and name are required." }, 400);

  await db.markSigned(env, inv.id, { signature_png: body.signature_png, signer_name: body.signer_name });
  const signed = await db.getInvoiceByToken(env, token);
  const payments = await db.getPayments(env, inv.id);

  const filed = await fileAllDocuments(env, signed, payments);
  ctx.waitUntil(notifySigned(env, signed, filed.ok));

  return json({ ok: true, invoice_no: signed.invoice_no, filed: filed.ok, fileError: filed.error });
}

// Builds and files all 3 documents (Agreement, Booking Invoice, Deposit Invoice).
// Signature is saved regardless of filing success — filing can always be retried
// from the admin "Re-file" button, so a Drive hiccup never loses the client's signature.
// `ok` carries both the Drive file id (for the DB) and webViewLink (for the Telegram
// notification, so Kenneth can open the signed PDF straight from the message).
async function fileAllDocuments(env, inv, payments) {
  const month = monthOf(inv.booking_date);
  const ok = { agreement: null, bookingInvoice: null, depositInvoice: null };
  let error = null;
  try {
    const agreementBytes = await buildAgreementPdf(env, inv);
    const agreementFiled = await fileToDrive(env, { monthName: month, filename: docName(inv, "Agreement"), pdfBytes: agreementBytes });
    ok.agreement = agreementFiled;

    const bookingBytes = await buildBookingInvoicePdf(env, inv, payments);
    const bookingFiled = await fileToDrive(env, { monthName: month, filename: docName(inv, "BookingInvoice"), pdfBytes: bookingBytes });
    ok.bookingInvoice = bookingFiled;

    const depositBytes = await buildDepositInvoicePdf(env, inv, payments);
    const depositFiled = await fileToDrive(env, { monthName: month, filename: docName(inv, "DepositInvoice"), pdfBytes: depositBytes });
    ok.depositInvoice = depositFiled;

    await db.setDriveFileIds(env, inv.id, { agreement: ok.agreement?.id, bookingInvoice: ok.bookingInvoice?.id, depositInvoice: ok.depositInvoice?.id });
  } catch (e) {
    error = String((e && e.message) || e);
    console.log("FILE ERROR", error);
    // save whatever succeeded before the failure
    await db.setDriveFileIds(env, inv.id, { agreement: ok.agreement?.id, bookingInvoice: ok.bookingInvoice?.id, depositInvoice: ok.depositInvoice?.id });
  }
  return { ok, error };
}

// ---------------------------------------------------------------------------
// Telegram inbound webhook — create an invoice from a fixed template message.
// ---------------------------------------------------------------------------
const TELEGRAM_TEMPLATE_HELP =
  `Send a new booking in this exact format:\n\n` +
  `Name: Jane Tan\n` +
  `NRIC/UEN: S1234567A\n` +
  `Event Type: Social\n` +
  `Venue: Whole Venue\n` +
  `Date of Event: 2026-08-15\n` +
  `Time Start: 14:00\n` +
  `Duration: 8\n` +
  `Purpose: Birthday party\n` +
  `Other: 10% discount\n\n` +
  `Event Type: Social, Corporate, or Seminar. Venue: Whole Venue or Main Hall Only. ` +
  `Date must be YYYY-MM-DD. Other is optional — leave blank or omit if no discount/promo.`;

async function telegramWebhook(env, request) {
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg || !msg.text) return json({ ok: true }); // ignore non-text updates (edits, etc.)

  const chatId = String(msg.chat && msg.chat.id);
  if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.log("[telegram] ignored message from unauthorized chat_id " + chatId);
    return json({ ok: true }); // silently ignore — don't leak that this endpoint does anything
  }

  const fields = parseTelegramTemplate(msg.text);
  if (!fields.name || !fields["date of event"]) {
    await sendTelegram(env, chatId, TELEGRAM_TEMPLATE_HELP);
    return json({ ok: true });
  }

  try {
    const event_type = titleCase(fields["event type"] || "Social");
    const venue_space = fields["venue"] && /main hall/i.test(fields["venue"]) ? "Main Hall Only" : "Whole Venue";
    if (!EVENT_TYPES.includes(event_type) || !VENUE_SPACES.includes(venue_space)) {
      await sendTelegram(env, chatId,
        `⚠️ Couldn't recognize Event Type "${fields["event type"] || ""}" or Venue "${fields["venue"] || ""}".\n\n${TELEGRAM_TEMPLATE_HELP}`);
      return json({ ok: true });
    }

    const booking_date = fields["date of event"];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(booking_date)) {
      await sendTelegram(env, chatId, `⚠️ Date "${booking_date}" must be in YYYY-MM-DD format, e.g. 2026-08-15.`);
      return json({ ok: true });
    }

    const start_time = fields["time start"] || null;
    const hours = Number(fields["duration"]) || 4;
    const end_time = start_time ? addHours(start_time, hours) : null;

    const preDiscount = computeQuote({ event_type, venue_space, booking_date, hours });
    const disc = parseDiscount(fields["other"], preDiscount.grand_total);
    const q = computeQuote({ event_type, venue_space, booking_date, hours, discount: disc.amount });

    const row = await db.createInvoice(env, {
      client_name: fields.name,
      client_phone: null,
      client_email: null,
      client_nric_uen: fields["nric/uen"] || fields["nric"] || fields["uen"] || null,
      event_type, venue_space, booking_date, start_time, end_time,
      hours: q.hours, hourly_rate: q.hourly_rate, cleaning_fee: q.cleaning_fee,
      deposit_amount: q.deposit_amount, pet_fee: q.pet_fee,
      discount: q.discount, discount_note: disc.note || null,
      rental_total: q.rental_total, grand_total: q.grand_total,
      notes: fields.purpose || null,
    });

    const signing_url = `${env.PUBLIC_BASE_URL}/sign/${row.token}`;
    const discountLine = q.discount > 0 ? `Discount: -$${q.discount.toFixed(2)} (${disc.note})\n` : (fields.other ? `⚠️ Couldn't parse discount "${fields.other}" — left at $0, review in admin.\n` : "");
    await sendTelegram(env, chatId,
      `✅ ${row.invoice_no} created for ${row.client_name}\n` +
      `${event_type} · ${venue_space} · ${booking_date}${start_time ? " " + start_time : ""} (${hours}h)\n` +
      `Booking total: $${q.grand_total.toFixed(2)}   Deposit: $${q.deposit_amount.toFixed(2)}\n` +
      discountLine +
      `Signing link:\n${signing_url}`
    );
  } catch (e) {
    console.log("[telegram] error creating invoice", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong creating that invoice: ${String((e && e.message) || e)}`);
  }

  return json({ ok: true });
}

function parseTelegramTemplate(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]*?)\s*:\s*(.*)$/);
    if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return fields;
}
function titleCase(s) {
  const t = String(s || "").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
function addHours(timeStr, hours) {
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h)) return null;
  const totalMin = h * 60 + (m || 0) + Math.round(Number(hours) * 60);
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  const endH = Math.floor(wrapped / 60), endM = wrapped % 60;
  return String(endH).padStart(2, "0") + ":" + String(endM).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
async function adminApi(env, parts, method, request) {
  // parts: ['api','invoices', maybe :no, maybe action]
  if (parts[1] !== "invoices") return json({ error: "unknown route" }, 404);

  if (parts.length === 2) {
    if (method === "POST") return createInvoice(env, request);
    if (method === "GET") return json({ invoices: await db.listInvoices(env) });
    return json({ error: "method not allowed" }, 405);
  }

  const no = parts[2];
  const action = parts[3];

  if (!action && method === "GET") {
    const inv = await db.getInvoiceByNo(env, no);
    if (!inv) return json({ error: "not found" }, 404);
    return json({
      invoice: inv,
      payments: await db.getPayments(env, inv.id),
      signing_url: `${env.PUBLIC_BASE_URL}/sign/${inv.token}`,
    });
  }
  if (action === "payments" && method === "POST") return addPayment(env, no, request);
  if (action === "status" && method === "POST") return setStatus(env, no, request);
  if (action === "refile" && method === "POST") return refile(env, no);
  if (action === "void" && method === "POST") return voidInvoice(env, no);

  return json({ error: "unknown route" }, 404);
}

async function createInvoice(env, request) {
  const b = await request.json().catch(() => ({}));
  if (!b.client_name || !b.booking_date || !b.event_type || !b.venue_space)
    return json({ error: "client_name, booking_date, event_type, venue_space are required" }, 400);

  // Discount can arrive either as free text to parse ("10% off") or an already-known
  // flat amount — the admin form sends text; the Telegram path could send either.
  let discount = b.discount, discountNote = b.discount_note || null;
  if ((discount === undefined || discount === null || discount === "") && b.discount_text) {
    const pre = computeQuote(b);
    const parsed = parseDiscount(b.discount_text, pre.grand_total);
    discount = parsed.amount;
    discountNote = parsed.note || null;
  }

  const q = computeQuote({ ...b, discount });
  const row = await db.createInvoice(env, {
    client_name: b.client_name,
    client_phone: b.client_phone || null,
    client_email: b.client_email || null,
    client_nric_uen: b.client_nric_uen || null,
    event_type: b.event_type,
    venue_space: b.venue_space,
    booking_date: b.booking_date,
    start_time: b.start_time || null,
    end_time: b.end_time || null,
    hours: q.hours,
    hourly_rate: q.hourly_rate,
    cleaning_fee: q.cleaning_fee,
    deposit_amount: q.deposit_amount,
    pet_fee: q.pet_fee,
    discount: q.discount,
    discount_note: discountNote,
    rental_total: q.rental_total,
    grand_total: q.grand_total,
    rental_fee_note: b.rental_fee_note || null,
    cleaning_fee_note: b.cleaning_fee_note || null,
    deposit_note: b.deposit_note || null,
    pet_fee_note: b.pet_fee_note || null,
    promo_clause_title: b.promo_clause_title || null,
    promo_clause_text: b.promo_clause_text || null,
    notes: b.notes || null,
  });
  return json({ invoice: row, signing_url: `${env.PUBLIC_BASE_URL}/sign/${row.token}` });
}

async function addPayment(env, no, request) {
  const inv = await db.getInvoiceByNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  const b = await request.json().catch(() => ({}));
  if (!b.amount || !b.kind || !b.paid_on) return json({ error: "amount, kind, paid_on required" }, 400);
  await db.addPayment(env, inv.id, { amount: Number(b.amount), kind: b.kind, paid_on: b.paid_on, note: b.note });
  return json({ ok: true });
}

async function setStatus(env, no, request) {
  const inv = await db.getInvoiceByNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  const b = await request.json().catch(() => ({}));
  await db.setStatus(env, inv.id, {
    payment_status: b.payment_status,
    cleaning_fee_status: b.cleaning_fee_status,
    deposit_status: b.deposit_status,
  });
  return json({ ok: true });
}

async function refile(env, no) {
  const inv = await db.getInvoiceByNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  const payments = await db.getPayments(env, inv.id);
  const filed = await fileAllDocuments(env, inv, payments);
  if (filed.error && !filed.ok.agreement && !filed.ok.bookingInvoice && !filed.ok.depositInvoice) {
    return json({ error: filed.error }, 500);
  }
  return json({ ok: true, drive: filed.ok, error: filed.error });
}

async function voidInvoice(env, no) {
  const inv = await db.getInvoiceByNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  await db.voidInvoice(env, inv.id);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function monthOf(dateStr) {
  return String(dateStr || "").slice(0, 7); // YYYY-MM
}
function docName(inv, kind) {
  const clean = String(inv.client_name || "client").replace(/[^A-Za-z0-9]+/g, "");
  return `${inv.invoice_no}_${kind}_${clean}_${inv.booking_date}.pdf`;
}
