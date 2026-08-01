// BojioVenue Worker — router + request handlers.
//
// Routes
//   GET  /                         -> admin UI (key-gated in the browser)
//   GET  /admin                    -> admin UI
//   GET  /sign/:token              -> public signing page (shows the Agreement)
//   GET  /api/sign/:token          -> public: booking + agreement data for the signing page
//   POST /api/sign/:token          -> public: submit signature -> Agreement + 2 Invoice PDFs -> Drive -> notify
//   GET  /sign/:token/download     -> public: client's own copy of the signed Agreement (only once signed)
//   GET  /addendum/:token          -> public: Security Deposit Deduction Addendum acknowledgment page
//   GET  /api/addendum/:token      -> public: deduction data for the acknowledgment page
//   POST /api/addendum/:token      -> public: submit acknowledgment -> file PDF -> notify Kenneth
//   POST /telegram/webhook         -> Telegram bot inbound — this IS the admin interface, not just
//                                      notifications: new bookings (confirm-before-create flow via
//                                      inline buttons), status updates ("INV-003 deposit paid"), preview,
//                                      deposit deductions ("INV-003 deduct 150 reason: ..."), and refund
//                                      proof photos (caption must contain the invoice number).
//                                      Restricted to Kenneth's own chat_id — see TELEGRAM_CHAT_ID.
//   --- everything below requires  Authorization: Bearer <ADMIN_KEY> ---
//   POST /api/invoices             -> create + issue an invoice (assigns INV-###)
//   GET  /api/invoices             -> list
//   GET  /api/invoices/:no         -> one invoice + payments
//   POST /api/invoices/:no/payments-> log a payment
//   POST /api/invoices/:no/status  -> set payment/cleaning/deposit status
//   POST /api/invoices/:no/refile  -> regenerate the 3 PDFs + re-upload to Drive
//   POST /api/invoices/:no/void    -> void (keeps the number)
//   GET  /api/promos               -> list all promos
//   POST /api/promos               -> create a promo preset
//   POST /api/promos/:id/active    -> activate/deactivate a promo

import * as db from "./db.js";
import { computeQuote, parseDiscount, parsePercent, findActivePromo, EVENT_TYPES, VENUE_SPACES } from "./pricing.js";
import { buildBookingInvoicePdf, buildDepositInvoicePdf } from "./pdf.js";
import { agreementHtml, buildAgreementPdf } from "./agreement.js";
import { buildRentalReceiptPdf, buildDepositReceiptPdf } from "./receipts.js";
import { buildDeductionAddendumPdf, deductionHtml } from "./deductions.js";
import { payNowQrSvg, invoicePayNowPayload } from "./paynow.js";
import { fileToDrive } from "./drive.js";
import { notifySigned, sendTelegram, answerCallbackQuery, sendTelegramDocument, getTelegramPhotoBytes } from "./notify.js";
import { adminPage, signPage, addendumPage } from "./pages.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const html = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

const SIGNING_LINK_DAYS = 7;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ['api','invoices','INV-001','void']
    const method = request.method;

    try {
      // ---- Public: signing page + its API -------------------------------
      if (parts[0] === "sign" && parts[1] && parts[2] === "download") return downloadSignedCopy(env, parts[1]);
      if (parts[0] === "sign" && parts[1]) return html(signPage(env, parts[1]));

      if (parts[0] === "api" && parts[1] === "sign" && parts[2]) {
        if (method === "GET") return getSignData(env, parts[2]);
        if (method === "POST") return submitSignature(env, ctx, parts[2], request);
        return json({ error: "method not allowed" }, 405);
      }

      // ---- Public: deduction addendum acknowledgment + its API -----------
      if (parts[0] === "addendum" && parts[1]) return html(addendumPage(env, parts[1]));

      if (parts[0] === "api" && parts[1] === "addendum" && parts[2]) {
        if (method === "GET") return getAddendumData(env, parts[2]);
        if (method === "POST") return submitAcknowledgment(env, ctx, parts[2], request);
        return json({ error: "method not allowed" }, 405);
      }

      // ---- Telegram inbound webhook --------------------------------------
      if (parts[0] === "telegram" && parts[1] === "webhook" && method === "POST") {
        return telegramWebhook(env, ctx, request);
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

  // Daily cron (see wrangler.toml [triggers]) — one-time reminders to Kenneth's
  // Telegram: an agreement sent but unsigned after 3 days, a deposit not yet
  // collected with the event 7 days out, a refund not yet paid out 4+ working days
  // after the event (Clause 8.1), and a deduction balance not yet paid out 3+
  // working days after acknowledgment (Clause 8.4). Each fires once per booking/
  // deduction (see the *_reminder_sent_at columns) so nothing gets re-reported daily.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReminders(env));
  },
};

async function runDailyReminders(env) {
  try {
    const unsigned = await db.listUnsignedNeedingReminder(env);
    for (const inv of unsigned) {
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${inv.invoice_no} (${inv.client_name}) was sent to the client but is still unsigned after 3+ days.\n` +
        `Event: ${inv.booking_date} · ${event_summary(inv)}\n` +
        `Signing link: ${env.PUBLIC_BASE_URL}/sign/${inv.token}`);
      await db.markTimestampOnce(env, inv.id, "unsigned_reminder_sent_at");
    }

    const depositsDue = await db.listDepositsDueNeedingReminder(env);
    for (const inv of depositsDue) {
      const amountDue = Number(inv.deposit_amount || 0) + Number(inv.cleaning_fee || 0);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${inv.invoice_no} (${inv.client_name}) — event on ${inv.booking_date} is within 7 days and the deposit + cleaning fee ($${amountDue.toFixed(2)}) hasn't been collected yet.\n` +
        `Reply "${inv.invoice_no} deposit paid" once it comes in.`);
      await db.markTimestampOnce(env, inv.id, "deposit_reminder_sent_at");
    }

    // Addendum 4 — refund overdue (Clause 8.1: 5-7 working days). The DB query
    // returns candidates by calendar date only (SQLite has no working-day
    // arithmetic); the 4+ working-day threshold is checked here.
    const unrefunded = await db.listUnrefundedPastEvent(env);
    for (const inv of unrefunded) {
      const days = workingDaysSince(inv.booking_date);
      if (days < 4) continue;
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${inv.invoice_no} (${inv.client_name}) — the event was ${days} working days ago and the deposit hasn't been refunded yet (Clause 8.1 promises 5-7 working days).\n` +
        `Reply "${inv.invoice_no} refunded" once it's paid out.`);
      await db.markTimestampOnce(env, inv.id, "refund_reminder_sent_at");
    }

    // Addendum 4 — deduction balance overdue (Clause 8.4: 3 working days after
    // acknowledgment). Same calendar-date-first, working-days-in-JS pattern.
    const deductionsDue = await db.listDeductionsNeedingBalanceReminder(env);
    for (const ded of deductionsDue) {
      const days = workingDaysSince(ded.acknowledged_at);
      if (days < 3) continue;
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${ded.invoice_no} (${ded.client_name}) — the deduction addendum was acknowledged ${days} working days ago and the balance hasn't been paid out yet (Clause 8.4 promises 3 working days).\n` +
        `Reply "${ded.invoice_no} refunded" once it's paid out.`);
      await db.markDeductionReminderSent(env, ded.id);
    }
  } catch (e) {
    console.log("[cron] reminder run failed", e);
  }
}
function event_summary(inv) {
  return `${inv.event_type} · ${inv.venue_space}`;
}

// Counts Mon-Fri days strictly after `dateStr` (a date or datetime string — only
// the date portion is used) through today, inclusive of today. Known gap: doesn't
// account for Singapore public holidays — matches the same documented limitation
// as pricing.js's isWeekend(), not fixed here either.
function workingDaysSince(dateStr) {
  const start = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
  let count = 0;
  const d = new Date(start);
  while (d < today) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Link expiry — 7 days from creation, but ONLY while unsigned. Once signed, the
// record and its documents are permanent; expiry only governs how long a client
// has to review and sign before the offer lapses.
// ---------------------------------------------------------------------------
function isExpired(inv) {
  if (inv.status === "signed" || inv.status === "void") return false;
  const created = new Date(String(inv.created_at).replace(" ", "T") + "Z");
  return Date.now() - created.getTime() > SIGNING_LINK_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Public signing
// ---------------------------------------------------------------------------
// The next payment the client should make, in Kenneth's two-payment flow: rental
// fee first (confirms the booking), then deposit + cleaning fee (due 7 days before
// the event). Returns null once both are settled — no QR needed at that point.
function nextPaymentDue(inv) {
  if (inv.payment_status !== "Paid") {
    return { amount: inv.rental_total, label: "Rental Fee", kind: "rental" };
  }
  if (inv.deposit_status !== "Held") {
    return { amount: Number(inv.deposit_amount || 0) + Number(inv.cleaning_fee || 0), label: "Deposit + Cleaning Fee", kind: "deposit" };
  }
  return null;
}

async function getSignData(env, token) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  if (inv.status === "void") return json({ error: "This invoice has been cancelled." }, 410);
  if (isExpired(inv)) return json({ error: "This signing link has expired. Contact BojioVenue for a new one.", expired: true }, 410);

  const due = nextPaymentDue(inv);
  // Only expose what the signing page needs — no phone/full payment history.
  const safe = {
    invoice_no: inv.invoice_no, status: inv.status, client_name: inv.client_name,
    event_type: inv.event_type, venue_space: inv.venue_space, booking_date: inv.booking_date,
    grand_total: inv.grand_total, deposit_amount: inv.deposit_amount,
    agreement_title: inv.venue_space === "Main Hall Only" ? "Seminar / Training Room Rental Agreement" : "Event Space Rental Agreement",
    agreement_html: agreementHtml(env, inv),
    payment_due: due
      ? { amount: due.amount, label: due.label, qr_svg: payNowQrSvg(invoicePayNowPayload(env, inv, due.amount, due.kind)) }
      : null,
  };
  return json({ invoice: safe });
}

async function submitSignature(env, ctx, token, request) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  if (inv.status === "void") return json({ error: "This invoice has been cancelled." }, 410);
  if (inv.status === "signed") return json({ error: "Already signed.", already: true }, 409);
  if (isExpired(inv)) return json({ error: "This signing link has expired. Contact BojioVenue for a new one.", expired: true }, 410);

  const body = await request.json().catch(() => ({}));
  if (!body.signature_png || !body.signer_name) return json({ error: "Signature and name are required." }, 400);

  await db.markSigned(env, inv.id, { signature_png: body.signature_png, signer_name: body.signer_name });
  const signed = await db.getInvoiceByToken(env, token);
  const payments = await db.getPayments(env, inv.id);

  const filed = await fileAllDocuments(env, signed, payments);
  ctx.waitUntil(notifySigned(env, signed, filed.ok));

  return json({ ok: true, invoice_no: signed.invoice_no, filed: filed.ok, fileError: filed.error });
}

// Client's own copy, per addendum ("optional pull, never pushed"). Regenerated
// fresh from the DB record rather than re-fetched from Drive — keeps Kenneth's
// Drive folder fully private (no public sharing link ever created on those files),
// while the client can still always grab their own copy via the same token that
// let them sign in the first place.
async function downloadSignedCopy(env, token) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  if (inv.status !== "signed") return json({ error: "Not signed yet." }, 404);
  const pdfBytes = await buildAgreementPdf(env, inv);
  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${docName(inv, "Agreement")}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Public: deduction addendum acknowledgment (Addendum 4). A booking can have more
// than one deduction, so "balance refundable" is a RUNNING total — every OTHER
// deduction on the same booking filed before this one also comes off the deposit.
// ---------------------------------------------------------------------------
async function priorDeductionsTotal(env, deduction) {
  const all = await db.listDeductionsForInvoice(env, deduction.invoice_id);
  return all.filter((d) => d.id < deduction.id).reduce((s, d) => s + Number(d.amount || 0), 0);
}

async function getAddendumData(env, token) {
  const ded = await db.getDeductionByToken(env, token);
  if (!ded) return json({ error: "not found" }, 404);
  const inv = await db.getInvoiceById(env, ded.invoice_id);
  if (!inv) return json({ error: "not found" }, 404);

  const priorTotal = await priorDeductionsTotal(env, ded);
  const balance = Math.max(0, Number(inv.deposit_amount || 0) - priorTotal - Number(ded.amount || 0));
  const safe = {
    invoice_no: inv.invoice_no, event_type: inv.event_type, venue_space: inv.venue_space, booking_date: inv.booking_date,
    amount: ded.amount, status: ded.status, balance_refundable: balance,
    addendum_html: deductionHtml(env, inv, ded, priorTotal),
  };
  return json({ deduction: safe });
}

async function submitAcknowledgment(env, ctx, token, request) {
  const ded = await db.getDeductionByToken(env, token);
  if (!ded) return json({ error: "not found" }, 404);
  if (ded.status === "acknowledged") return json({ error: "Already acknowledged.", already: true }, 409);

  const body = await request.json().catch(() => ({}));
  if (!body.signature_png || !body.acknowledger_name) return json({ error: "Signature and name are required." }, 400);

  await db.acknowledgeDeduction(env, ded.id, { signature_png: body.signature_png, acknowledger_name: body.acknowledger_name });
  const fresh = await db.getDeductionByToken(env, token);
  const inv = await db.getInvoiceById(env, ded.invoice_id);
  const priorTotal = await priorDeductionsTotal(env, ded);
  const balance = Math.max(0, Number(inv.deposit_amount || 0) - priorTotal - Number(fresh.amount || 0));

  ctx.waitUntil((async () => {
    try {
      const all = await db.listDeductionsForInvoice(env, ded.invoice_id);
      const index = all.findIndex((d) => d.id === ded.id) + 1;
      const bytes = await buildDeductionAddendumPdf(env, inv, fresh, priorTotal);
      const filename = `${inv.invoice_no}_DeductionAddendum${all.length > 1 ? "_" + index : ""}.pdf`;
      const filed = await fileToDrive(env, { monthName: monthOf(inv.booking_date), filename, pdfBytes: bytes });
      await db.setDeductionDriveFileId(env, ded.id, filed.id);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `✅ ${inv.invoice_no}: deduction addendum acknowledged by ${fresh.acknowledger_name}.\n` +
        `Deduction: $${Number(fresh.amount).toFixed(2)} · Balance refundable: $${balance.toFixed(2)}\n` +
        `Filed: ${filed.webViewLink}\n\n` +
        `Balance is due within 3 working days (Clause 8.4) — pay out, then reply "${inv.invoice_no} refunded" + forward the transfer screenshot.`);
    } catch (e) {
      console.log("[addendum] filing failed", e);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID, `✅ ${inv.invoice_no}: deduction acknowledged by ${fresh.acknowledger_name}, but filing to Drive failed: ${String((e && e.message) || e)}`);
    }
  })());

  return json({ ok: true });
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
// Promo-aware quote — the single path both the admin form AND Telegram use, so
// "active promo auto-applies to new bookings" holds true regardless of channel.
// Explicit rental_fee_note/cleaning_fee_note/promo_clause_title/promo_clause_text
// passed by the caller always win over the promo's own defaults for those fields.
// ---------------------------------------------------------------------------
async function computeQuoteWithPromo(env, params) {
  const promos = await db.listActivePromos(env);
  const promo = findActivePromo(promos, params.booking_date);
  const q = computeQuote({ ...params, promo });
  const applied = q.appliedPromo;
  return {
    ...q,
    rental_fee_note: params.rental_fee_note || (applied ? applied.rental_fee_note : null),
    cleaning_fee_note: params.cleaning_fee_note || (applied ? applied.cleaning_fee_note : null),
    promo_clause_title: params.promo_clause_title || (applied ? applied.clause_title : null),
    promo_clause_text: params.promo_clause_text || (applied ? applied.clause_text : null),
    promo_id: applied ? applied.id : null,
  };
}

// ---------------------------------------------------------------------------
// Telegram — this IS Kenneth's admin interface (per addendum), not just
// notifications. Two kinds of inbound text: a new-booking template, or a status
// command like "INV-003 deposit paid"; plus inline-button callback queries for
// the confirm/send/preview/edit flow. Deterministic parsing only — no AI/LLM
// calls, to keep this at $0 recurring cost and avoid a model misreading a real
// invoice's numbers.
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
  `Rate: 150\n` +
  `Discount: 10\n` +
  `Other: \n\n` +
  `Event Type: Social, Corporate, or Seminar. Venue: Whole Venue or Main Hall Only. ` +
  `Date must be YYYY-MM-DD. Rate and Discount are for Social bookings only — Rate is the ` +
  `$/hr package rate for this booking (leave blank to use the usual weekday/weekend rate), ` +
  `Discount is a plain % (leave blank for none; a promo may suggest both automatically). ` +
  `Corporate/Seminar bookings use Other: for a free-text discount instead (e.g. "10% off").\n\n` +
  `Or update an existing booking: "INV-003 rental paid", "INV-003 deposit paid", ` +
  `"INV-003 cleaning paid", "INV-003 partially paid". ` +
  `"INV-003 stage" shows where a booking currently stands.\n\n` +
  `After the event: "INV-003 refunded" (+ forward your bank transfer screenshot with ` +
  `the invoice number as its caption, to file it as proof) for a clean payout, or ` +
  `"INV-003 deduct 150 reason: stained sofa" to issue a Security Deposit Deduction ` +
  `Addendum first — you'll get an acknowledgment link to send the client yourself.`;

async function telegramWebhook(env, ctx, request) {
  const update = await request.json().catch(() => ({}));

  if (update.callback_query) return telegramCallback(env, update.callback_query);

  const msg = update.message;
  if (!msg) return json({ ok: true }); // ignore non-message updates (edited_message, etc.)

  const chatId = String(msg.chat && msg.chat.id);
  if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.log("[telegram] ignored message from unauthorized chat_id " + chatId);
    return json({ ok: true }); // silently ignore — don't leak that this endpoint does anything
  }

  // Refund-proof screenshots (Addendum 4) — Kenneth attaches the photo with the
  // invoice number as its caption. No text field on a photo message, so this has
  // to be checked before the text-only handling below.
  if (msg.photo && msg.photo.length) return telegramRefundProofPhoto(env, chatId, msg);

  if (!msg.text) return json({ ok: true }); // ignore stickers, voice notes, etc.

  const statusMatch = msg.text.match(/^\s*(INV-\d+)\s+(.+)$/i);
  if (statusMatch) return telegramStatusUpdate(env, chatId, statusMatch[1].toUpperCase(), statusMatch[2]);

  return telegramNewBooking(env, chatId, msg.text);
}

// Downloads the largest available resolution of an inbound photo and files it to
// the booking's month folder as proof of a refund/balance payout. Requires the
// invoice number in the photo's caption — the natural one-step way to send a photo
// with context in Telegram (attach + type a caption + send), and the only reliable
// way to know which booking a bare screenshot belongs to.
async function telegramRefundProofPhoto(env, chatId, msg) {
  const caption = String(msg.caption || "");
  const invMatch = caption.match(/INV-\d+/i);
  if (!invMatch) {
    await sendTelegram(env, chatId,
      `📸 Got the photo, but couldn't find an invoice number in the caption. Please resend with the invoice number (e.g. "INV-005") as the photo's caption.`);
    return json({ ok: true });
  }
  const invoiceNo = invMatch[0].toUpperCase();
  const inv = await db.getInvoiceByNo(env, invoiceNo);
  if (!inv) {
    await sendTelegram(env, chatId, `⚠️ ${invoiceNo} not found.`);
    return json({ ok: true });
  }
  try {
    const largest = msg.photo[msg.photo.length - 1]; // Telegram lists photo sizes smallest-first
    const bytes = await getTelegramPhotoBytes(env, largest.file_id);
    const filename = `${inv.invoice_no}_RefundProof.jpg`;
    const filed = await fileToDrive(env, { monthName: monthOf(inv.booking_date), filename, pdfBytes: bytes, mimeType: "image/jpeg" });
    await db.setRefundProofFileId(env, inv.id, filed.id);
    await sendTelegram(env, chatId,
      `✅ Refund proof filed for ${invoiceNo}: ${filed.webViewLink}` +
      (inv.deposit_status !== "Refunded" ? `\n\nTip: this only files the proof — reply "${invoiceNo} refunded" to also mark the deposit as refunded.` : ""));
  } catch (e) {
    console.log("[telegram] refund proof upload failed", e);
    await sendTelegram(env, chatId, `⚠️ Couldn't file the photo: ${String((e && e.message) || e)}`);
  }
  return json({ ok: true });
}

async function telegramNewBooking(env, chatId, text) {
  const fields = parseTelegramTemplate(text);
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
    const client_nric_uen = fields["nric/uen"] || fields["nric"] || fields["uen"] || null;

    // Social: dedicated Rate:/Discount: fields feed the usual/package/discount%
    // model directly. Corporate/Seminar: unchanged free-text Other: field, parsed
    // as a flat $ discount — that engine has no percent-discount concept.
    const manualRate = fields["rate"] !== undefined && fields["rate"] !== "" ? Number(fields["rate"]) : undefined;
    let q, discountNote;
    if (event_type === "Social") {
      const discount_percent = fields["discount"] ? parsePercent(fields["discount"]) : undefined;
      q = await computeQuoteWithPromo(env, { event_type, venue_space, booking_date, hours, hourly_rate: manualRate, discount_percent });
      discountNote = q.discount_percent > 0 ? `${q.discount_percent}% discount` : null;
    } else {
      const preDiscount = await computeQuoteWithPromo(env, { event_type, venue_space, booking_date, hours, hourly_rate: manualRate });
      const disc = parseDiscount(fields["other"], preDiscount.grand_total);
      q = await computeQuoteWithPromo(env, { event_type, venue_space, booking_date, hours, hourly_rate: manualRate, discount: disc.amount });
      discountNote = disc.note || null;
    }

    const pendingData = {
      client_name: fields.name, client_phone: null, client_email: null, client_nric_uen,
      event_type, venue_space, booking_date, start_time, end_time,
      hours: q.hours, usual_rate: q.usual_rate, hourly_rate: q.hourly_rate, rental_subtotal: q.rental_subtotal,
      discount_percent: q.discount_percent, cleaning_fee: q.cleaning_fee,
      deposit_amount: q.deposit_amount, pet_fee: q.pet_fee,
      discount: q.discount, discount_note: discountNote,
      rental_total: q.rental_total, grand_total: q.grand_total,
      rental_fee_note: q.rental_fee_note, cleaning_fee_note: q.cleaning_fee_note,
      promo_clause_title: q.promo_clause_title, promo_clause_text: q.promo_clause_text, promo_id: q.promo_id,
      notes: fields.purpose || null,
    };
    const pendingId = await db.createPendingBooking(env, chatId, pendingData);

    const promoLine = q.promo_id ? `Promo applied: ${q.rental_fee_note || "yes"}\n` : "";
    const breakdown = event_type === "Social"
      ? `Usual rate: $${q.usual_rate.toFixed(2)}/hr   Package rate: $${q.hourly_rate.toFixed(2)}/hr\n` +
        `Subtotal: $${q.hourly_rate.toFixed(2)} × ${hours}h = $${q.rental_subtotal.toFixed(2)}\n` +
        (q.discount_percent > 0 ? `Discount: ${q.discount_percent}% (-$${q.discount.toFixed(2)})\n` : "") +
        `Rental: $${q.rental_total.toFixed(2)}   Cleaning: $${q.cleaning_fee.toFixed(2)}\n`
      : `Rental: $${q.rental_total.toFixed(2)} (rate $${q.hourly_rate.toFixed(2)}/hr)   Cleaning: $${q.cleaning_fee.toFixed(2)}\n` +
        (q.discount > 0 ? `Discount: -$${q.discount.toFixed(2)}${discountNote ? " (" + discountNote + ")" : ""}\n` : (fields.other ? `⚠️ Couldn't parse "${fields.other}" as a discount — left at $0.\n` : ""));
    await sendTelegram(env, chatId,
      `📋 Review booking for ${fields.name}\n` +
      `${event_type} · ${venue_space} · ${booking_date}${start_time ? " " + start_time : ""} (${hours}h)\n` +
      breakdown + promoLine +
      `Booking total: $${q.grand_total.toFixed(2)}   Deposit: $${q.deposit_amount.toFixed(2)}\n\n` +
      `Confirm to create this invoice, or cancel to discard.`,
      [[{ text: "✅ Confirm", callback_data: `confirm:${pendingId}` }, { text: "❌ Cancel", callback_data: `cancel:${pendingId}` }]]
    );
  } catch (e) {
    console.log("[telegram] error preparing booking", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong: ${String((e && e.message) || e)}`);
  }

  return json({ ok: true });
}

// Recognized status phrases after "INV-XXX ". Checked in order — first match wins.
// Order matters: "unpaid" contains "paid" as a substring, so every *.unpaid rule
// must be checked before the *.paid rule it would otherwise be swallowed by.
//
// `receipt` (Addendum 3): which payment-confirmation receipt this phrase triggers,
// if any. "rental paid" -> Receipt #1. "deposit paid" now bundles the cleaning fee
// into the SAME payment event (Kenneth collects them together, 7 days before the
// event) -> Receipt #2 covers both, and cleaning_fee_status flips alongside deposit_status.
//
// The refund rule (Addendum 4) matches bare "refund"/"refunded" — not just "deposit
// refunded" — since Kenneth's own example command is literally "INV-XXX refunded"
// with no "deposit" in it. Safe to match broadly: by the time a booking reaches
// this stage, "refund" unambiguously means the deposit — there's nothing else left
// to refund. Covers BOTH refund paths (plain, or the balance after a deduction) —
// same command either way, per Kenneth's own description.
const STATUS_PHRASES = [
  { re: /refund/i, apply: { deposit_status: "Refunded" }, refile: "deposit", label: "Deposit refunded" },
  { re: /clean(ing)?.*unpaid/i, apply: { cleaning_fee_status: "Unpaid" }, refile: "booking", label: "Cleaning fee marked unpaid" },
  { re: /deposit.*paid|paid.*deposit/i, apply: { deposit_status: "Held", cleaning_fee_status: "Paid" }, refile: "deposit", receipt: "deposit", label: "Deposit + cleaning fee marked paid" },
  { re: /clean(ing)?.*paid/i, apply: { cleaning_fee_status: "Paid" }, refile: "deposit", label: "Cleaning fee marked paid" },
  { re: /partial/i, apply: { payment_status: "Partially Paid" }, refile: "booking", label: "Rental marked partially paid" },
  { re: /unpaid/i, apply: { payment_status: "Unpaid" }, refile: "booking", label: "Rental marked unpaid" },
  { re: /(booking|rental|final).*paid|paid.*(booking|rental)|^paid$/i, apply: { payment_status: "Paid" }, refile: "booking", receipt: "rental", label: "Rental fee marked paid" },
];

// "INV-XXX deduct 150 reason: stained sofa" — not a fixed STATUS_PHRASES entry
// since it carries a dynamic amount + free-text reason, not a fixed status value.
const DEDUCT_RE = /^deduct\s+(\d+(?:\.\d+)?)\s+reason:\s*(.+)$/i;

// "INV-XXX stage" / "INV-XXX status" — a read-only check, handled before the
// mutating STATUS_PHRASES so it can never be misread as a payment update.
// `deductions`: pre-fetched by the caller (see telegramStatusUpdate) so this stays
// a pure function, matching the rest of this file's data-fetch/logic separation.
function computeStage(inv, deductions) {
  if (inv.status === "void") return "Void (cancelled)";
  if (inv.status === "issued") {
    if (!inv.sent_at) return "Quote (not yet sent to client)";
    return "Agreement Sent (awaiting signature)";
  }
  // signed:
  const eventPast = inv.booking_date < new Date().toISOString().slice(0, 10);
  if (inv.payment_status !== "Paid") return "Signed (awaiting rental payment)";
  if (inv.deposit_status === "Not Collected") return eventPast ? "Event Done (deposit not yet collected)" : "Deposit Due (awaiting deposit + cleaning fee)";

  const hasDeductions = deductions && deductions.length > 0;
  if (inv.deposit_status === "Refunded") {
    return hasDeductions ? "Closed — Balance Paid Out (after deduction)" : "Closed — Deposit Refunded";
  }
  // deposit_status === "Held" from here:
  if (!eventPast) return "Deposit Paid (event upcoming)";
  if (!hasDeductions) return "Event Done (awaiting refund)";
  return deductions.some((d) => d.status === "pending")
    ? "Deduction Filed (awaiting client acknowledgment)"
    : "Acknowledged (balance payout due)";
}

async function telegramStatusUpdate(env, chatId, invoiceNo, statusText) {
  const inv = await db.getInvoiceByNo(env, invoiceNo);
  if (!inv) {
    await sendTelegram(env, chatId, `⚠️ ${invoiceNo} not found.`);
    return json({ ok: true });
  }

  if (/^(stage|status)$/i.test(statusText.trim())) {
    const deductions = await db.listDeductionsForInvoice(env, inv.id);
    await sendTelegram(env, chatId, `📍 ${invoiceNo} (${inv.client_name}): ${computeStage(inv, deductions)}`);
    return json({ ok: true });
  }

  const deductMatch = statusText.trim().match(DEDUCT_RE);
  if (deductMatch) return telegramDeductCommand(env, chatId, inv, Number(deductMatch[1]), deductMatch[2].trim());

  const match = STATUS_PHRASES.find((p) => p.re.test(statusText));
  if (!match) {
    await sendTelegram(env, chatId,
      `⚠️ Didn't recognize "${statusText}" for ${invoiceNo}. Try: "rental paid", "deposit paid", "cleaning paid", "deposit refunded", "partially paid", ` +
      `"deduct 150 reason: ...", or "stage".`);
    return json({ ok: true });
  }

  // Auto-log a matching payments-table entry the FIRST time each field actually
  // flips to paid/held — otherwise "Total received"/"Balance outstanding" (and the
  // PayNow QR's show-if-balance>0 check) never learn that a Telegram-marked payment
  // came in, since those are computed from the payments log, not the status fields
  // directly. Compares before/after per field so bundled ("deposit paid" also flips
  // cleaning_fee_status) and standalone ("cleaning paid" alone) cases both log
  // correctly without double-counting on a repeated command.
  const today = new Date().toISOString().slice(0, 10);
  if (match.apply.payment_status === "Paid" && inv.payment_status !== "Paid") {
    const total = inv.event_type === "Social"
      ? round2(Number(inv.rental_total) + Number(inv.pet_fee || 0))
      : round2(Number(inv.rental_total) + Number(inv.pet_fee || 0) - Number(inv.discount || 0));
    await db.addPayment(env, inv.id, { amount: total, kind: "balance", paid_on: today, note: "Auto-logged (Telegram: rental paid)" });
  }
  if (match.apply.deposit_status === "Held" && inv.deposit_status !== "Held") {
    await db.addPayment(env, inv.id, { amount: Number(inv.deposit_amount || 0), kind: "deposit", paid_on: today, note: "Auto-logged (Telegram: deposit paid)" });
  }
  if (match.apply.cleaning_fee_status === "Paid" && inv.cleaning_fee_status !== "Paid") {
    await db.addPayment(env, inv.id, { amount: Number(inv.cleaning_fee || 0), kind: "cleaning_fee", paid_on: today, note: "Auto-logged (Telegram: cleaning fee paid)" });
  }
  // Refund (Addendum 4): amount is the deposit MINUS any deductions filed on this
  // booking, so this correctly logs the full deposit for a plain refund or just the
  // remaining balance after a deduction, without the caller needing to know which.
  let pendingDeductionWarning = "";
  if (match.apply.deposit_status === "Refunded" && inv.deposit_status !== "Refunded") {
    const deductions = await db.listDeductionsForInvoice(env, inv.id);
    const deductedTotal = deductions.reduce((s, d) => s + Number(d.amount || 0), 0);
    const refundAmount = Math.max(0, Number(inv.deposit_amount || 0) - deductedTotal);
    await db.addPayment(env, inv.id, { amount: refundAmount, kind: "refund", paid_on: today, note: "Auto-logged (Telegram: refunded)" });
    await db.markTimestampOnce(env, inv.id, "deposit_refunded_at");
    const pending = deductions.find((d) => d.status === "pending");
    if (pending) pendingDeductionWarning = `\n⚠️ Note: this booking has a deduction awaiting client acknowledgment (${env.PUBLIC_BASE_URL}/addendum/${pending.token}) — double check the client agreed before paying out.`;
  }

  await db.setStatus(env, inv.id, match.apply);
  const updated = await db.getInvoiceByNo(env, invoiceNo);

  let refileNote = "";
  if (updated.status === "signed") {
    const payments = await db.getPayments(env, updated.id);
    try {
      if (match.refile === "deposit") {
        const bytes = await buildDepositInvoicePdf(env, updated, payments);
        const filed = await fileToDrive(env, { monthName: monthOf(updated.booking_date), filename: docName(updated, "DepositInvoice"), pdfBytes: bytes });
        await db.setDriveFileIds(env, updated.id, { depositInvoice: filed.id });
        refileNote = `\nDeposit Invoice refiled: ${filed.webViewLink}`;
      } else {
        const bytes = await buildBookingInvoicePdf(env, updated, payments);
        const filed = await fileToDrive(env, { monthName: monthOf(updated.booking_date), filename: docName(updated, "BookingInvoice"), pdfBytes: bytes });
        await db.setDriveFileIds(env, updated.id, { bookingInvoice: filed.id });
        refileNote = `\nBooking Invoice refiled: ${filed.webViewLink}`;
      }
    } catch (e) {
      refileNote = `\n⚠️ Status updated, but refiling the PDF failed: ${String((e && e.message) || e)}`;
    }

    if (match.receipt) refileNote += await generateAndSendReceipt(env, chatId, updated, match.receipt);
  } else {
    refileNote = "\n(Not yet signed — nothing to refile yet; status will show once it is.)";
  }

  await sendTelegram(env, chatId, `✅ ${invoiceNo}: ${match.label}.${refileNote}${pendingDeductionWarning}`);
  return json({ ok: true });
}

// "INV-XXX deduct 150 reason: ..." — creates the deduction and hands back the
// acknowledgment link. Kenneth sends this to the client himself (email/WhatsApp) —
// no automated email sending in v1, per the addendum's explicit scope.
async function telegramDeductCommand(env, chatId, inv, amount, reason) {
  try {
    const deduction = await db.createDeduction(env, inv.id, { amount, reason });
    const link = `${env.PUBLIC_BASE_URL}/addendum/${deduction.token}`;
    await sendTelegram(env, chatId,
      `📋 Deduction filed for ${inv.invoice_no}: $${amount.toFixed(2)} (${reason}).\n\n` +
      `Acknowledgment link — send this to the client yourself:\n${link}\n\n` +
      `You'll get a Telegram notification once they acknowledge, and the addendum PDF will be filed to Drive then.`);
  } catch (e) {
    console.log("[telegram] deduct command failed", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong filing the deduction: ${String((e && e.message) || e)}`);
  }
  return json({ ok: true });
}

// Builds + files the rental or deposit payment receipt, records the payment-event
// timestamp (once only — re-applying the same command later won't move it), and
// sends the PDF straight to Kenneth's Telegram so he can forward it on WhatsApp.
async function generateAndSendReceipt(env, chatId, inv, kind) {
  try {
    const timestampCol = kind === "rental" ? "rental_paid_at" : "deposit_paid_at";
    await db.markTimestampOnce(env, inv.id, timestampCol);
    const fresh = await db.getInvoiceByNo(env, inv.invoice_no); // pick up the timestamp just set

    const bytes = kind === "rental" ? await buildRentalReceiptPdf(env, fresh) : await buildDepositReceiptPdf(env, fresh);
    const filename = docName(fresh, kind === "rental" ? "RentalReceipt" : "DepositReceipt");
    const filed = await fileToDrive(env, { monthName: monthOf(fresh.booking_date), filename, pdfBytes: bytes });
    await db.setReceiptFileIds(env, fresh.id, kind === "rental" ? { rentalReceipt: filed.id } : { depositReceipt: filed.id });
    await sendTelegramDocument(env, chatId, filename, bytes, `Receipt for ${fresh.invoice_no} — forward to the client if needed.`);
    return `\nReceipt generated and filed: ${filed.webViewLink}`;
  } catch (e) {
    console.log("[telegram] receipt generation failed", e);
    return `\n⚠️ Payment recorded, but the receipt failed to generate: ${String((e && e.message) || e)}`;
  }
}

async function telegramCallback(env, cq) {
  const chatId = String(cq.message && cq.message.chat && cq.message.chat.id);
  if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
    await answerCallbackQuery(env, cq.id);
    return json({ ok: true });
  }

  const [action, ref] = String(cq.data || "").split(":");
  try {
    if (action === "confirm") {
      const pending = await db.getPendingBooking(env, ref);
      if (!pending) {
        await answerCallbackQuery(env, cq.id, "This has expired or was already handled.");
        return json({ ok: true });
      }
      const row = await db.createInvoice(env, pending.data);
      await db.deletePendingBooking(env, ref);
      await answerCallbackQuery(env, cq.id, "Confirmed!");
      await sendTelegram(env, chatId,
        `✅ ${row.invoice_no} created for ${row.client_name}. Not sent to the client yet.`,
        [[
          { text: "📤 Send signing link", callback_data: `send:${row.invoice_no}` },
          { text: "👁 Preview", callback_data: `preview:${row.invoice_no}` },
          { text: "✏️ Edit", callback_data: `edit:${row.invoice_no}` },
        ]]
      );
    } else if (action === "cancel") {
      await db.deletePendingBooking(env, ref);
      await answerCallbackQuery(env, cq.id, "Cancelled.");
      await sendTelegram(env, chatId, "❌ Booking discarded — nothing was created.");
    } else if (action === "send") {
      const inv = await db.getInvoiceByNo(env, ref);
      await answerCallbackQuery(env, cq.id);
      if (!inv) { await sendTelegram(env, chatId, `⚠️ ${ref} not found.`); return json({ ok: true }); }
      await db.markTimestampOnce(env, inv.id, "sent_at"); // starts the 3-day unsigned-reminder clock
      await sendTelegram(env, chatId, `Signing link for ${ref} (forward this to the client):\n${env.PUBLIC_BASE_URL}/sign/${inv.token}`);
    } else if (action === "preview") {
      const inv = await db.getInvoiceByNo(env, ref);
      await answerCallbackQuery(env, cq.id, "Generating preview...");
      if (!inv) { await sendTelegram(env, chatId, `⚠️ ${ref} not found.`); return json({ ok: true }); }
      const bytes = await buildAgreementPdf(env, inv);
      await sendTelegramDocument(env, chatId, docName(inv, "Agreement"), bytes, `Preview: ${ref} (unsigned)`);
    } else if (action === "edit") {
      await answerCallbackQuery(env, cq.id);
      await sendTelegram(env, chatId,
        `To edit ${ref}: void it from /admin, then resend the corrected booking details as a new message. ` +
        `(Field-level editing via Telegram isn't built yet — this is the v1 workaround.)`);
    } else {
      await answerCallbackQuery(env, cq.id);
    }
  } catch (e) {
    console.log("[telegram] callback error", e);
    await answerCallbackQuery(env, cq.id, "Something went wrong — check /admin.");
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
  // parts: ['api', 'invoices'|'promos', maybe :id/:no, maybe action]
  if (parts[1] === "promos") return promosApi(env, parts, method, request);
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

async function promosApi(env, parts, method, request) {
  if (parts.length === 2) {
    if (method === "GET") return json({ promos: await db.listAllPromos(env) });
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.name || !b.valid_from || !b.valid_to) return json({ error: "name, valid_from, valid_to are required" }, 400);
      const promo = await db.createPromo(env, b);
      return json({ promo });
    }
    return json({ error: "method not allowed" }, 405);
  }
  const id = parts[2], action = parts[3];
  if (action === "active" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    await db.setPromoActive(env, id, b.active);
    return json({ ok: true });
  }
  return json({ error: "unknown route" }, 404);
}

async function createInvoice(env, request) {
  const b = await request.json().catch(() => ({}));
  if (!b.client_name || !b.booking_date || !b.event_type || !b.venue_space)
    return json({ error: "client_name, booking_date, event_type, venue_space are required" }, 400);

  // Social: dedicated discount_percent field, feeding the usual/package/discount%
  // model directly. Corporate/Seminar: unchanged free-text discount_text, parsed as
  // a flat $ amount — that engine has no percent-discount concept.
  let q, discountNote;
  if (b.event_type === "Social") {
    q = await computeQuoteWithPromo(env, { ...b, discount_percent: b.discount_percent });
    discountNote = q.discount_percent > 0 ? `${q.discount_percent}% discount` : null;
  } else {
    let discount = b.discount, discountNote2 = b.discount_note || null;
    if ((discount === undefined || discount === null || discount === "") && b.discount_text) {
      const pre = await computeQuoteWithPromo(env, b);
      const parsed = parseDiscount(b.discount_text, pre.grand_total);
      discount = parsed.amount;
      discountNote2 = parsed.note || null;
    }
    q = await computeQuoteWithPromo(env, { ...b, discount });
    discountNote = discountNote2;
  }

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
    usual_rate: q.usual_rate,
    hourly_rate: q.hourly_rate,
    rental_subtotal: q.rental_subtotal,
    discount_percent: q.discount_percent,
    cleaning_fee: q.cleaning_fee,
    deposit_amount: q.deposit_amount,
    pet_fee: q.pet_fee,
    discount: q.discount,
    discount_note: discountNote,
    rental_total: q.rental_total,
    grand_total: q.grand_total,
    rental_fee_note: b.rental_fee_note || q.rental_fee_note || null,
    cleaning_fee_note: b.cleaning_fee_note || q.cleaning_fee_note || null,
    deposit_note: b.deposit_note || null,
    pet_fee_note: b.pet_fee_note || null,
    promo_clause_title: b.promo_clause_title || q.promo_clause_title || null,
    promo_clause_text: b.promo_clause_text || q.promo_clause_text || null,
    promo_id: q.promo_id || null,
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
function round2(n) {
  return Math.round(n * 100) / 100;
}
function docName(inv, kind) {
  const clean = String(inv.client_name || "client").replace(/[^A-Za-z0-9]+/g, "");
  return `${inv.invoice_no}_${kind}_${clean}_${inv.booking_date}.pdf`;
}
