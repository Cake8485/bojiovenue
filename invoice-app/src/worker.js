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
//                                      inline buttons), status updates ("2026036 deposit paid", or any
//                                      prefixed doc number like "RRC-2026036 paid paynow ocbc ref 123" —
//                                      see BOOKING_REF_RE), preview, deposit deductions ("2026036 deduct
//                                      150 reason: ..."), and refund proof photos (caption must contain
//                                      the booking number). Restricted to Kenneth's own chat_id — see
//                                      TELEGRAM_CHAT_ID.
//   --- everything below requires  Authorization: Bearer <ADMIN_KEY> ---
//   POST /api/invoices             -> create + issue an invoice (assigns a booking number, e.g. 2026036)
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
import { buildRentalInvoicePdf, buildSecurityDepositPdf } from "./pdf.js";
import { agreementHtml, buildAgreementPdf } from "./agreement.js";
import { buildRentalReceiptPdf } from "./receipts.js";
import { buildDeductionAddendumPdf, deductionHtml } from "./deductions.js";
import { payNowQrSvg, invoicePayNowPayload } from "./paynow.js";
import { fileToDrive, ensureBookingFolder, ensureSubfolder, moveFolder, renameFolder, getAccessToken } from "./drive.js";
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
        `⏰ ${inv.booking_no} (${inv.client_name}) was sent to the client but is still unsigned after 3+ days.\n` +
        `Event: ${inv.booking_date} · ${event_summary(inv)}\n` +
        `Signing link: ${env.PUBLIC_BASE_URL}/sign/${inv.token}`);
      await db.markTimestampOnce(env, inv.id, "unsigned_reminder_sent_at");
    }

    const depositsDue = await db.listDepositsDueNeedingReminder(env);
    for (const inv of depositsDue) {
      const amountDue = Number(inv.deposit_amount || 0) + Number(inv.cleaning_fee || 0);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${inv.booking_no} (${inv.client_name}) — event on ${inv.booking_date} is within 7 days and the deposit + cleaning fee ($${amountDue.toFixed(2)}) hasn't been collected yet.\n` +
        `Reply "${inv.booking_no} deposit paid" once it comes in.`);
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
        `⏰ ${inv.booking_no} (${inv.client_name}) — the event was ${days} working days ago and the deposit hasn't been refunded yet (Clause 8.1 promises 5-7 working days).\n` +
        `Reply "${inv.booking_no} refunded" once it's paid out.`);
      await db.markTimestampOnce(env, inv.id, "refund_reminder_sent_at");
    }

    // Addendum 4 — deduction balance overdue (Clause 8.4: 3 working days after
    // acknowledgment). Same calendar-date-first, working-days-in-JS pattern.
    const deductionsDue = await db.listDeductionsNeedingBalanceReminder(env);
    for (const ded of deductionsDue) {
      const days = workingDaysSince(ded.acknowledged_at);
      if (days < 3) continue;
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `⏰ ${ded.booking_no} (${ded.client_name}) — the deduction addendum was acknowledged ${days} working days ago and the balance hasn't been paid out yet (Clause 8.4 promises 3 working days).\n` +
        `Reply "${ded.booking_no} refunded" once it's paid out.`);
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
    booking_no: inv.booking_no, status: inv.status, client_name: inv.client_name,
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

  return json({ ok: true, booking_no: signed.booking_no, filed: filed.ok, fileError: filed.error });
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
      "Content-Disposition": `attachment; filename="${docName(inv, "AGR")}"`,
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
    booking_no: inv.booking_no, event_type: inv.event_type, venue_space: inv.venue_space, booking_date: inv.booking_date,
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
      const filename = docName(inv, "DDA", "pdf", all.length > 1 ? "-" + index : "");
      const folderId = await getBookingFolderId(env, inv);
      const filed = await fileToDrive(env, { folderId, filename, pdfBytes: bytes });
      await db.setDeductionDriveFileId(env, ded.id, filed.id);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID,
        `✅ ${inv.booking_no}: deduction addendum acknowledged by ${fresh.acknowledger_name}.\n` +
        `Deduction: $${Number(fresh.amount).toFixed(2)} · Balance refundable: $${balance.toFixed(2)}\n` +
        `Filed: ${filed.webViewLink}\n\n` +
        `Balance is due within 3 working days (Clause 8.4) — pay out, then reply "${inv.booking_no} refunded" + forward the transfer screenshot.`);
    } catch (e) {
      console.log("[addendum] filing failed", e);
      await sendTelegram(env, env.TELEGRAM_CHAT_ID, `✅ ${inv.booking_no}: deduction acknowledged by ${fresh.acknowledger_name}, but filing to Drive failed: ${String((e && e.message) || e)}`);
    }
  })());

  return json({ ok: true });
}

// Builds and files the 3 documents generated at signing time: Agreement (AGR),
// Rental Invoice (INV), Security Deposit doc (SD). RRC (rental receipt) is NOT
// filed here — it only exists once rental payment is confirmed (see
// generateAndSendReceipt) — and SD gets refiled in place by later payment events
// (see telegramStatusUpdate), not by this function again.
// Signature is saved regardless of filing success — filing can always be retried
// from the admin "Re-file" button, so a Drive hiccup never loses the client's signature.
// `ok` carries both the Drive file id (for the DB) and webViewLink (for the Telegram
// notification, so Kenneth can open the signed PDF straight from the message).
async function fileAllDocuments(env, inv, payments) {
  const ok = { agreement: null, rentalInvoice: null, securityDeposit: null };
  let error = null;
  try {
    const folderId = await getBookingFolderId(env, inv);

    const agreementBytes = await buildAgreementPdf(env, inv);
    const agreementFiled = await fileToDrive(env, { folderId, filename: docName(inv, "AGR"), pdfBytes: agreementBytes });
    ok.agreement = agreementFiled;

    const rentalBytes = await buildRentalInvoicePdf(env, inv, payments);
    const rentalFiled = await fileToDrive(env, { folderId, filename: docName(inv, "INV"), pdfBytes: rentalBytes });
    ok.rentalInvoice = rentalFiled;

    const depositBytes = await buildSecurityDepositPdf(env, inv, payments);
    const depositFiled = await fileToDrive(env, { folderId, filename: docName(inv, "SD"), pdfBytes: depositBytes });
    ok.securityDeposit = depositFiled;

    await db.setDriveFileIds(env, inv.id, { agreement: ok.agreement?.id, rentalInvoice: ok.rentalInvoice?.id });
    await db.setSecurityDepositFileId(env, inv.id, ok.securityDeposit?.id);
  } catch (e) {
    error = String((e && e.message) || e);
    console.log("FILE ERROR", error);
    // save whatever succeeded before the failure
    await db.setDriveFileIds(env, inv.id, { agreement: ok.agreement?.id, rentalInvoice: ok.rentalInvoice?.id });
    if (ok.securityDeposit?.id) await db.setSecurityDepositFileId(env, inv.id, ok.securityDeposit.id);
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
// command addressed by booking number ("2026036 deposit paid") — see
// BOOKING_REF_RE for why any doc prefix (RRC-/INV-/etc.) works too, matching
// Kenneth's own example of typing whatever number he's currently looking at; plus
// inline-button callback queries for the confirm/send/preview/edit flow.
// Deterministic parsing only — no AI/LLM calls, to keep this at $0 recurring cost
// and avoid a model misreading a real invoice's numbers.
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
  `Cleaning With: Deposit\n` +
  `Other: \n\n` +
  `Event Type: Social, Corporate, or Seminar. Venue: Whole Venue or Main Hall Only. ` +
  `Date must be YYYY-MM-DD. Rate and Discount are for Social bookings only — Rate is the ` +
  `$/hr package rate for this booking (leave blank to use the usual weekday/weekend rate), ` +
  `Discount is a plain % (leave blank for none; a promo may suggest both automatically). ` +
  `Cleaning With: Rental or Deposit — which payment the cleaning fee is billed with ` +
  `(leave blank to default to Deposit). ` +
  `Corporate/Seminar bookings use Other: for a free-text discount instead (e.g. "10% off").\n\n` +
  `Or update an existing booking — address it by its booking number (e.g. "2026036"), or by ` +
  `any document number on whatever you're looking at (e.g. "RRC-2026036"), doesn't matter which: ` +
  `"2026036 rental paid", "2026036 deposit paid", "2026036 cleaning paid", "2026036 partially paid". ` +
  `Add payment details after "paid" and they're saved to the receipt's Notes, e.g. ` +
  `"RRC-2026036 paid paynow ocbc ref 5358482". ` +
  `"2026036 stage" shows where a booking currently stands.\n\n` +
  `After the event: "2026036 refunded" (+ forward your bank transfer screenshot with ` +
  `the booking number as its caption, to file it as proof) for a clean payout, or ` +
  `"2026036 deduct 150 reason: stained sofa" to issue a Security Deposit Deduction ` +
  `Addendum first — you'll get an acknowledgment link to send the client yourself.\n\n` +
  `"2026036 postpone to 2026-09-20" moves the booking date (and its Drive folder, ` +
  `if the month changed) — the price stays as originally agreed.`;

// Addendum 6: a booking is addressed by its bare 7-digit booking number
// ("2026036"), optionally prefixed by ANY of its document letters (AGR-/INV-/
// RRC-/SD-/DDA-) and optionally suffixed with a deduction index ("-2") — Kenneth's
// own example command types the RRC- prefix ("RRC-2026036 paid ..."), i.e.
// whatever number he happens to be looking at, so the prefix is deliberately not
// validated against a fixed list. Capture group 1 is always just the 7 digits.
const BOOKING_REF_RE = /(?:[A-Za-z]+-)?(\d{7})(?:-\d+)?/;
const BOOKING_REF_LINE_RE = new RegExp(`^\\s*${BOOKING_REF_RE.source}\\s+([\\s\\S]+)$`);

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
  // booking number as its caption. No text field on a photo message, so this has
  // to be checked before the text-only handling below.
  if (msg.photo && msg.photo.length) return telegramRefundProofPhoto(env, chatId, msg);

  if (!msg.text) return json({ ok: true }); // ignore stickers, voice notes, etc.

  const statusMatch = msg.text.match(BOOKING_REF_LINE_RE);
  if (statusMatch) return telegramStatusUpdate(env, chatId, statusMatch[1], statusMatch[2]);

  return telegramNewBooking(env, chatId, msg.text);
}

// Downloads the largest available resolution of an inbound photo and files it to
// the booking's month folder as proof of a refund/balance payout. Requires the
// booking number in the photo's caption — the natural one-step way to send a photo
// with context in Telegram (attach + type a caption + send), and the only reliable
// way to know which booking a bare screenshot belongs to.
async function telegramRefundProofPhoto(env, chatId, msg) {
  const caption = String(msg.caption || "");
  const refMatch = caption.match(BOOKING_REF_RE);
  if (!refMatch) {
    await sendTelegram(env, chatId,
      `📸 Got the photo, but couldn't find a booking number in the caption. Please resend with the booking number (e.g. "2026036") as the photo's caption.`);
    return json({ ok: true });
  }
  const bookingNo = refMatch[1];
  const inv = await db.getInvoiceByBookingNo(env, bookingNo);
  if (!inv) {
    await sendTelegram(env, chatId, `⚠️ ${bookingNo} not found.`);
    return json({ ok: true });
  }
  try {
    const largest = msg.photo[msg.photo.length - 1]; // Telegram lists photo sizes smallest-first
    const bytes = await getTelegramPhotoBytes(env, largest.file_id);
    const filename = docName(inv, "RefundProof", "jpg");
    const folderId = await getBookingFolderId(env, inv);
    const filed = await fileToDrive(env, { folderId, filename, pdfBytes: bytes, mimeType: "image/jpeg" });
    await db.setRefundProofFileId(env, inv.id, filed.id);
    await sendTelegram(env, chatId,
      `✅ Refund proof filed for ${bookingNo}: ${filed.webViewLink}` +
      (inv.deposit_status !== "Refunded" ? `\n\nTip: this only files the proof — reply "${bookingNo} refunded" to also mark the deposit as refunded.` : ""));
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
    // Addendum 6: which payment the cleaning fee is billed with — defaults to
    // Deposit (Kenneth's stated default) for anything blank or unrecognized.
    const cleaning_fee_with = /^rental$/i.test(String(fields["cleaning with"] || "").trim()) ? "rental" : "deposit";

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
      discount_percent: q.discount_percent, cleaning_fee: q.cleaning_fee, cleaning_fee_with,
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
      `Booking total: $${q.grand_total.toFixed(2)}   Deposit: $${q.deposit_amount.toFixed(2)}\n` +
      `Cleaning fee billed with: ${cleaning_fee_with === "rental" ? "Rental" : "Deposit"}\n\n` +
      `Confirm to create this invoice, or cancel to discard.`,
      [[{ text: "✅ Confirm", callback_data: `confirm:${pendingId}` }, { text: "❌ Cancel", callback_data: `cancel:${pendingId}` }]]
    );
  } catch (e) {
    console.log("[telegram] error preparing booking", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong: ${String((e && e.message) || e)}`);
  }

  return json({ ok: true });
}

// Recognized status phrases after a booking reference. Checked in order — first
// match wins. Order matters: "unpaid" contains "paid" as a substring, so every
// *.unpaid rule must be checked before the *.paid rule it would otherwise be
// swallowed by.
//
// `receipt` (Addendum 3): true if this phrase triggers the ONE receipt this system
// generates (RRC, rental only — Addendum 6 collapsed the deposit side to a single
// evolving SD document with no receipt counterpart, see pdf.js). "deposit paid"
// still bundles the cleaning fee into the SAME payment event (Kenneth collects them
// together, 7 days before the event) when it's allocated there — cleaning_fee_status
// flips alongside deposit_status either way, regardless of which document shows it.
//
// Which document(s) need refiling after a match is no longer hand-annotated here —
// see docsAffectedByStatusChange, which derives it generically from `apply` (which
// fields actually changed) so it can't drift out of sync with cleaning_fee_with.
//
// The refund rule (Addendum 4) matches bare "refund"/"refunded" — not just "deposit
// refunded" — since Kenneth's own example command is literally "<booking> refunded"
// with no "deposit" in it. Safe to match broadly: by the time a booking reaches
// this stage, "refund" unambiguously means the deposit — there's nothing else left
// to refund. Covers BOTH refund paths (plain, or the balance after a deduction) —
// same command either way, per Kenneth's own description.
// `apply` may be a plain object OR a function of `inv` (see resolveApply below) —
// only the two "paid together" entries need the function form, since Addendum 6's
// cleaning_fee_with means whether cleaning fee actually bundles into a rental-paid
// or deposit-paid event now depends on the booking, not fixed per phrase like before.
const STATUS_PHRASES = [
  { re: /refund/i, apply: { deposit_status: "Refunded" }, label: "Deposit refunded" },
  { re: /clean(ing)?.*unpaid/i, apply: { cleaning_fee_status: "Unpaid" }, label: "Cleaning fee marked unpaid" },
  {
    re: /deposit.*paid|paid.*deposit/i,
    apply: (inv) => ({ deposit_status: "Held", ...((inv.cleaning_fee_with || "deposit") === "deposit" ? { cleaning_fee_status: "Paid" } : {}) }),
    label: "Deposit marked paid",
  },
  { re: /clean(ing)?.*paid/i, apply: { cleaning_fee_status: "Paid" }, label: "Cleaning fee marked paid" },
  { re: /partial/i, apply: { payment_status: "Partially Paid" }, label: "Rental marked partially paid" },
  { re: /unpaid/i, apply: { payment_status: "Unpaid" }, label: "Rental marked unpaid" },
  {
    re: /(booking|rental|final).*paid|paid.*(booking|rental)|^paid$/i,
    apply: (inv) => ({ payment_status: "Paid", ...((inv.cleaning_fee_with || "deposit") === "rental" ? { cleaning_fee_status: "Paid" } : {}) }),
    receipt: true,
    label: "Rental fee marked paid",
  },
];
function resolveApply(match, inv) {
  return typeof match.apply === "function" ? match.apply(inv) : match.apply;
}

// Which money document(s) need refiling after `apply` (a STATUS_PHRASES match's
// status-field changes) actually lands — derived generically rather than
// hand-annotated per phrase, so it can't drift out of sync with which document a
// given booking's cleaning fee is actually shown on (see cleaning_fee_with).
// deposit_status -> "Refunded" is deliberately excluded: Addendum 6's SD document
// only ever models unpaid -> paid (its Balance Due was already $0 by the time a
// refund can happen), so a refund never changes anything SD would show.
function docsAffectedByStatusChange(inv, applied) {
  const docs = new Set();
  if ("payment_status" in applied) docs.add("rental");
  if ("deposit_status" in applied && applied.deposit_status !== "Refunded") docs.add("deposit");
  if ("cleaning_fee_status" in applied) docs.add((inv.cleaning_fee_with || "deposit") === "rental" ? "rental" : "deposit");
  return docs;
}

// "<booking> deduct 150 reason: stained sofa" — not a fixed STATUS_PHRASES entry
// since it carries a dynamic amount + free-text reason, not a fixed status value.
const DEDUCT_RE = /^deduct\s+(\d+(?:\.\d+)?)\s+reason:\s*(.+)$/i;

// "<booking> postpone to 2026-09-20" (or "postpone 2026-09-20") — Addendum 5. Price
// stays locked at whatever was originally agreed; this only moves the date and, if
// the month changed, the Drive folder.
const POSTPONE_RE = /^postpone\s+(?:to\s+)?(\d{4}-\d{2}-\d{2})$/i;

// Addendum 6 — strips optional trailing payment details ("paynow ocbc ref 5358482")
// from a status command's text BEFORE it's matched against STATUS_PHRASES/DEDUCT_RE/
// POSTPONE_RE, so all of that existing matching logic keeps working unchanged on
// whatever's left (e.g. "paid paynow ocbc ref 5358482" -> remaining "paid", exactly
// what the *.paid rule already expects). Kenneth's own example command
// ("RRC-2026036 paid paynow ocbc ref 5358482") is the reference case this is built
// against. Recognized tokens are intentionally short, common Singapore payment
// lists — anything unrecognized just isn't captured (remaining text is untouched),
// never guessed at.
const PAYMENT_MODES = ["paynow", "cash", "bank transfer", "transfer", "cheque", "paylah", "grabpay", "nets"];
const PAYMENT_BANKS = ["ocbc", "dbs", "posb", "uob", "maybank", "citibank", "standard chartered", "hsbc", "cimb", "icbc", "boc"];
function extractPaymentDetails(text) {
  let remaining = String(text || "").trim();
  let reference = null, mode = null, bank = null;

  const refMatch = remaining.match(/\bref(?:erence)?\.?\s+(\S+)\s*$/i);
  if (refMatch) {
    reference = refMatch[1];
    remaining = remaining.slice(0, refMatch.index).trim();
  }
  for (const b of PAYMENT_BANKS) {
    const re = new RegExp(`\\b${b}\\b\\s*$`, "i");
    if (re.test(remaining)) { bank = b.toUpperCase(); remaining = remaining.replace(re, "").trim(); break; }
  }
  for (const m of PAYMENT_MODES) {
    const re = new RegExp(`\\b${m}\\b\\s*$`, "i");
    if (re.test(remaining)) { mode = titleCase(m); remaining = remaining.replace(re, "").trim(); break; }
  }
  return { remaining, mode, bank, reference };
}

// "<booking> stage" / "<booking> status" — a read-only check, handled before the
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

async function telegramStatusUpdate(env, chatId, bookingNo, rawStatusText) {
  const inv = await db.getInvoiceByBookingNo(env, bookingNo);
  if (!inv) {
    await sendTelegram(env, chatId, `⚠️ ${bookingNo} not found.`);
    return json({ ok: true });
  }

  // Strip any trailing payment details ("paynow ocbc ref 5358482") up front — every
  // check below operates on `statusText` (the remainder), so a payment-mode/bank/
  // reference suffix never has to be anticipated by DEDUCT_RE/POSTPONE_RE/
  // STATUS_PHRASES individually.
  const { remaining: statusText, mode, bank, reference } = extractPaymentDetails(rawStatusText.trim());

  if (/^(stage|status)$/i.test(statusText)) {
    const deductions = await db.listDeductionsForInvoice(env, inv.id);
    await sendTelegram(env, chatId, `📍 ${bookingNo} (${inv.client_name}): ${computeStage(inv, deductions)}`);
    return json({ ok: true });
  }

  const deductMatch = statusText.match(DEDUCT_RE);
  if (deductMatch) return telegramDeductCommand(env, chatId, inv, Number(deductMatch[1]), deductMatch[2].trim());

  const postponeMatch = statusText.match(POSTPONE_RE);
  if (postponeMatch) return telegramPostponeCommand(env, chatId, inv, postponeMatch[1]);

  const match = STATUS_PHRASES.find((p) => p.re.test(statusText));
  if (!match) {
    await sendTelegram(env, chatId,
      `⚠️ Didn't recognize "${statusText}" for ${bookingNo}. Try: "rental paid", "deposit paid", "cleaning paid", "deposit refunded", "partially paid", ` +
      `"deduct 150 reason: ...", "postpone to YYYY-MM-DD", or "stage".`);
    return json({ ok: true });
  }
  // Resolved against THIS booking's cleaning_fee_with — see STATUS_PHRASES' comment
  // and resolveApply: "rental paid"/"deposit paid" only bundle cleaning_fee_status
  // when the cleaning fee is actually allocated to that side.
  const applied = resolveApply(match, inv);

  // Auto-log a matching payments-table entry the FIRST time each field actually
  // flips to paid/held — otherwise "Total received"/"Balance outstanding" (and the
  // PayNow QR's show-if-balance>0 check) never learn that a Telegram-marked payment
  // came in, since those are computed from the payments log, not the status fields
  // directly. Compares before/after per field so bundled ("deposit paid" also flips
  // cleaning_fee_status) and standalone ("cleaning paid" alone) cases both log
  // correctly without double-counting on a repeated command. Any payment mode/bank/
  // reference Kenneth typed is attached here too — see extractPaymentDetails.
  const today = new Date().toISOString().slice(0, 10);
  const paymentMeta = { payment_mode: mode, bank, reference };
  if (applied.payment_status === "Paid" && inv.payment_status !== "Paid") {
    const total = inv.event_type === "Social"
      ? round2(Number(inv.rental_total) + Number(inv.pet_fee || 0))
      : round2(Number(inv.rental_total) + Number(inv.pet_fee || 0) - Number(inv.discount || 0));
    await db.addPayment(env, inv.id, { amount: total, kind: "balance", paid_on: today, note: "Auto-logged (Telegram: rental paid)", ...paymentMeta });
  }
  if (applied.deposit_status === "Held" && inv.deposit_status !== "Held") {
    await db.addPayment(env, inv.id, { amount: Number(inv.deposit_amount || 0), kind: "deposit", paid_on: today, note: "Auto-logged (Telegram: deposit paid)", ...paymentMeta });
    // SD's own "Deposit Date" field reads this — previously set inside the generic
    // receipt-timestamp helper, which Addendum 6 narrowed to rental-only (SD has no
    // receipt of its own), so this needs its own explicit call now.
    await db.markTimestampOnce(env, inv.id, "deposit_paid_at");
  }
  if (applied.cleaning_fee_status === "Paid" && inv.cleaning_fee_status !== "Paid") {
    await db.addPayment(env, inv.id, { amount: Number(inv.cleaning_fee || 0), kind: "cleaning_fee", paid_on: today, note: "Auto-logged (Telegram: cleaning fee paid)", ...paymentMeta });
  }
  // Refund (Addendum 4): amount is the deposit MINUS any deductions filed on this
  // booking, so this correctly logs the full deposit for a plain refund or just the
  // remaining balance after a deduction, without the caller needing to know which.
  let pendingDeductionWarning = "";
  if (applied.deposit_status === "Refunded" && inv.deposit_status !== "Refunded") {
    const deductions = await db.listDeductionsForInvoice(env, inv.id);
    const deductedTotal = deductions.reduce((s, d) => s + Number(d.amount || 0), 0);
    const refundAmount = Math.max(0, Number(inv.deposit_amount || 0) - deductedTotal);
    await db.addPayment(env, inv.id, { amount: refundAmount, kind: "refund", paid_on: today, note: "Auto-logged (Telegram: refunded)", ...paymentMeta });
    await db.markTimestampOnce(env, inv.id, "deposit_refunded_at");
    const pending = deductions.find((d) => d.status === "pending");
    if (pending) pendingDeductionWarning = `\n⚠️ Note: this booking has a deduction awaiting client acknowledgment (${env.PUBLIC_BASE_URL}/addendum/${pending.token}) — double check the client agreed before paying out.`;
  }

  await db.setStatus(env, inv.id, applied);
  const updated = await db.getInvoiceByBookingNo(env, bookingNo);

  let refileNote = "";
  if (updated.status === "signed") {
    const affectedDocs = docsAffectedByStatusChange(inv, applied);
    const payments = await db.getPayments(env, updated.id);
    const folderId = await getBookingFolderId(env, updated);
    if (affectedDocs.has("deposit")) {
      try {
        const bytes = await buildSecurityDepositPdf(env, updated, payments);
        const filed = await fileToDrive(env, { folderId, filename: docName(updated, "SD"), pdfBytes: bytes });
        await db.setSecurityDepositFileId(env, updated.id, filed.id);
        refileNote += `\nDeposit doc refiled: ${filed.webViewLink}`;
      } catch (e) {
        refileNote += `\n⚠️ Status updated, but refiling the deposit doc failed: ${String((e && e.message) || e)}`;
      }
    }
    if (affectedDocs.has("rental")) {
      try {
        const bytes = await buildRentalInvoicePdf(env, updated, payments);
        const filed = await fileToDrive(env, { folderId, filename: docName(updated, "INV"), pdfBytes: bytes });
        await db.setDriveFileIds(env, updated.id, { rentalInvoice: filed.id });
        refileNote += `\nRental invoice refiled: ${filed.webViewLink}`;
      } catch (e) {
        refileNote += `\n⚠️ Status updated, but refiling the rental invoice failed: ${String((e && e.message) || e)}`;
      }
    }

    if (match.receipt) refileNote += await generateAndSendReceipt(env, chatId, updated);
  } else {
    refileNote = "\n(Not yet signed — nothing to refile yet; status will show once it is.)";
  }

  // "cleaning_fee_status" alongside "payment_status"/"deposit_status" in the SAME
  // applied object means this was one of the two "paid together" phrases actually
  // bundling the cleaning fee this time (see resolveApply) — worth calling out
  // since the label itself no longer says so unconditionally.
  const cleaningBundled = applied.cleaning_fee_status === "Paid" && (applied.payment_status !== undefined || applied.deposit_status !== undefined);
  await sendTelegram(env, chatId, `✅ ${bookingNo}: ${match.label}${cleaningBundled ? " (cleaning fee bundled in)" : ""}.${refileNote}${pendingDeductionWarning}`);
  return json({ ok: true });
}

// "<booking> deduct 150 reason: ..." — creates the deduction and hands back the
// acknowledgment link. Kenneth sends this to the client himself (email/WhatsApp) —
// no automated email sending in v1, per the addendum's explicit scope.
async function telegramDeductCommand(env, chatId, inv, amount, reason) {
  try {
    const deduction = await db.createDeduction(env, inv.id, { amount, reason });
    const link = `${env.PUBLIC_BASE_URL}/addendum/${deduction.token}`;
    await sendTelegram(env, chatId,
      `📋 Deduction filed for ${inv.booking_no}: $${amount.toFixed(2)} (${reason}).\n\n` +
      `Acknowledgment link — send this to the client yourself:\n${link}\n\n` +
      `You'll get a Telegram notification once they acknowledge, and the addendum PDF will be filed to Drive then.`);
  } catch (e) {
    console.log("[telegram] deduct command failed", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong filing the deduction: ${String((e && e.message) || e)}`);
  }
  return json({ ok: true });
}

// "<booking> postpone to 2026-09-20" — updates the booking date and, if the event
// moved into a different month, moves the existing Drive folder to match. Price
// stays exactly as originally agreed (Kenneth's choice) — this is a scheduling
// change, not a renegotiation. Deliberately does NOT touch void bookings, and does
// NOT regenerate any already-filed PDFs (they'll still show the original date until
// re-filed some other way) — flagged clearly in the reply rather than silently
// leaving stale documents without saying so.
async function telegramPostponeCommand(env, chatId, inv, newDate) {
  if (inv.status === "void") {
    await sendTelegram(env, chatId, `⚠️ ${inv.booking_no} is void — can't postpone a cancelled booking.`);
    return json({ ok: true });
  }
  const oldDate = inv.booking_date;
  const oldMonth = monthOf(oldDate);
  const newMonth = monthOf(newDate);

  try {
    await db.updateBookingDate(env, inv.id, newDate);

    // Rename ALWAYS runs (the {DDMon} suffix goes stale even for a same-month date
    // change, e.g. 08Aug -> 22Aug); the move only runs when the month itself changed.
    let moveNote = "";
    if (inv.drive_booking_folder_id) {
      const newFolderName = bookingFolderName({ ...inv, booking_date: newDate });
      await renameFolder(env, inv.drive_booking_folder_id, newFolderName);
      if (oldMonth !== newMonth) {
        const accessToken = await getAccessToken(env);
        const oldMonthFolderId = await ensureSubfolder(accessToken, env.DRIVE_PARENT_FOLDER_ID, oldMonth);
        const newMonthFolderId = await ensureSubfolder(accessToken, env.DRIVE_PARENT_FOLDER_ID, newMonth);
        await moveFolder(env, inv.drive_booking_folder_id, oldMonthFolderId, newMonthFolderId);
        moveNote = `\nDrive folder moved: ${oldMonth} → ${newMonth} (renamed to ${newFolderName})`;
      } else {
        moveNote = `\nDrive folder renamed to ${newFolderName}`;
      }
    }

    await sendTelegram(env, chatId,
      `📅 ${inv.booking_no}: postponed from ${oldDate} to ${newDate}. Price stays as originally agreed ($${Number(inv.grand_total).toFixed(2)}).${moveNote}\n\n` +
      `⚠️ Note: any already-filed Agreement/Invoice/Receipt PDFs still show the original date (${oldDate}) — only the booking record and Drive folder location have moved. Let me know if you also want those documents regenerated with the new date.`);
  } catch (e) {
    console.log("[telegram] postpone failed", e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong postponing: ${String((e && e.message) || e)}`);
  }
  return json({ ok: true });
}

// Builds + files the rental payment receipt (RRC — the only receipt this system
// still generates as of Addendum 6, the deposit side having collapsed to one
// evolving SD document, see pdf.js), records the rental_paid_at timestamp (once
// only — re-applying the same command later won't move it), and sends the PDF
// straight to Kenneth's Telegram so he can forward it on WhatsApp.
async function generateAndSendReceipt(env, chatId, inv) {
  try {
    await db.markTimestampOnce(env, inv.id, "rental_paid_at");
    const fresh = await db.getInvoiceByBookingNo(env, inv.booking_no); // pick up the timestamp just set
    const payments = await db.getPayments(env, fresh.id);

    const bytes = await buildRentalReceiptPdf(env, fresh, payments);
    const filename = docName(fresh, "RRC");
    const folderId = await getBookingFolderId(env, fresh);
    const filed = await fileToDrive(env, { folderId, filename, pdfBytes: bytes });
    await db.setRentalReceiptFileId(env, fresh.id, filed.id);
    await sendTelegramDocument(env, chatId, filename, bytes, `Receipt for ${fresh.booking_no} — forward to the client if needed.`);
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
        `✅ ${row.booking_no} created for ${row.client_name}. Not sent to the client yet.`,
        [[
          { text: "📤 Send signing link", callback_data: `send:${row.booking_no}` },
          { text: "👁 Preview", callback_data: `preview:${row.booking_no}` },
          { text: "✏️ Edit", callback_data: `edit:${row.booking_no}` },
        ]]
      );
    } else if (action === "cancel") {
      await db.deletePendingBooking(env, ref);
      await answerCallbackQuery(env, cq.id, "Cancelled.");
      await sendTelegram(env, chatId, "❌ Booking discarded — nothing was created.");
    } else if (action === "send") {
      const inv = await db.getInvoiceByBookingNo(env, ref);
      await answerCallbackQuery(env, cq.id);
      if (!inv) { await sendTelegram(env, chatId, `⚠️ ${ref} not found.`); return json({ ok: true }); }
      await db.markTimestampOnce(env, inv.id, "sent_at"); // starts the 3-day unsigned-reminder clock
      await sendTelegram(env, chatId, `Signing link for ${ref} (forward this to the client):\n${env.PUBLIC_BASE_URL}/sign/${inv.token}`);
    } else if (action === "preview") {
      const inv = await db.getInvoiceByBookingNo(env, ref);
      await answerCallbackQuery(env, cq.id, "Generating preview...");
      if (!inv) { await sendTelegram(env, chatId, `⚠️ ${ref} not found.`); return json({ ok: true }); }
      const bytes = await buildAgreementPdf(env, inv);
      await sendTelegramDocument(env, chatId, docName(inv, "AGR"), bytes, `Preview: ${ref} (unsigned)`);
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
    const inv = await db.getInvoiceByBookingNo(env, no);
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
    cleaning_fee_with: b.cleaning_fee_with === "rental" ? "rental" : "deposit",
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
  const inv = await db.getInvoiceByBookingNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  const b = await request.json().catch(() => ({}));
  if (!b.amount || !b.kind || !b.paid_on) return json({ error: "amount, kind, paid_on required" }, 400);
  await db.addPayment(env, inv.id, { amount: Number(b.amount), kind: b.kind, paid_on: b.paid_on, note: b.note, payment_mode: b.payment_mode, bank: b.bank, reference: b.reference });
  return json({ ok: true });
}

async function setStatus(env, no, request) {
  const inv = await db.getInvoiceByBookingNo(env, no);
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
  const inv = await db.getInvoiceByBookingNo(env, no);
  if (!inv) return json({ error: "not found" }, 404);
  const payments = await db.getPayments(env, inv.id);
  const filed = await fileAllDocuments(env, inv, payments);
  if (filed.error && !filed.ok.agreement && !filed.ok.rentalInvoice && !filed.ok.securityDeposit) {
    return json({ error: filed.error }, 500);
  }
  return json({ ok: true, drive: filed.ok, error: filed.error });
}

async function voidInvoice(env, no) {
  const inv = await db.getInvoiceByBookingNo(env, no);
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
// Addendum 6: filenames are just the document's own prefixed number — AGR-/INV-/
// RRC-/SD-/DDA-{booking_no} — since the booking folder (see bookingFolderName)
// already carries client/date context and the prefix itself now says what the
// document IS. `suffix` covers the 2nd+ deduction addendum on the same booking
// (e.g. "-2"); every other document has exactly one file, no suffix.
function docName(inv, prefix, ext, suffix) {
  return `${prefix}-${inv.booking_no}${suffix || ""}.${ext || "pdf"}`;
}

const DD_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ddMon(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  return String(d.getDate()).padStart(2, "0") + DD_MON[d.getMonth()];
}
function bookingFolderName(inv) {
  const clean = String(inv.client_name || "client").replace(/[^A-Za-z0-9]+/g, "");
  return `${inv.booking_no}_${clean}_${ddMon(inv.booking_date)}`;
}

// Resolves the Drive folder ID for this booking's documents, creating the
// month -> booking folder path on first use and caching the result on the invoice
// row so every later call (refiling, receipts, deductions, refund proof) is a
// single field read instead of a Drive search. Always re-derives the month from
// the invoice's CURRENT booking_date, so if a postpone moved the folder already,
// this naturally resolves to wherever it now lives.
async function getBookingFolderId(env, inv) {
  if (inv.drive_booking_folder_id) return inv.drive_booking_folder_id;
  const { folderId } = await ensureBookingFolder(env, monthOf(inv.booking_date), bookingFolderName(inv));
  await db.setBookingFolderId(env, inv.id, folderId);
  return folderId;
}
