// BojioVenue Worker — router + request handlers.
//
// Routes
//   GET  /                         -> admin UI (key-gated in the browser)
//   GET  /admin                    -> admin UI
//   GET  /sign/:token              -> public signing page (shows the Agreement)
//   GET  /api/sign/:token          -> public: booking + agreement data for the signing page
//   POST /api/sign/:token          -> public: submit signature -> Agreement + 2 Invoice PDFs -> Drive -> notify
//   GET  /sign/:token/download     -> public: client's own copy of the signed Agreement (only once signed)
//   POST /telegram/webhook         -> Telegram bot inbound — this IS the admin interface, not just
//                                      notifications: new bookings (confirm-before-create flow via
//                                      inline buttons), status updates ("INV-003 deposit paid"), preview.
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
import { computeQuote, parseDiscount, findActivePromo, EVENT_TYPES, VENUE_SPACES } from "./pricing.js";
import { buildBookingInvoicePdf, buildDepositInvoicePdf } from "./pdf.js";
import { agreementHtml, buildAgreementPdf } from "./agreement.js";
import { fileToDrive } from "./drive.js";
import { notifySigned, sendTelegram, answerCallbackQuery, sendTelegramDocument } from "./notify.js";
import { adminPage, signPage } from "./pages.js";

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
};

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
async function getSignData(env, token) {
  const inv = await db.getInvoiceByToken(env, token);
  if (!inv) return json({ error: "not found" }, 404);
  if (inv.status === "void") return json({ error: "This invoice has been cancelled." }, 410);
  if (isExpired(inv)) return json({ error: "This signing link has expired. Contact BojioVenue for a new one.", expired: true }, 410);
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
  `Other: 10% discount\n\n` +
  `Event Type: Social, Corporate, or Seminar. Venue: Whole Venue or Main Hall Only. ` +
  `Date must be YYYY-MM-DD. Other is optional — leave blank or omit if no extra discount.\n\n` +
  `Or update an existing booking: "INV-003 deposit paid", "INV-003 booking paid", ` +
  `"INV-003 cleaning paid", "INV-003 deposit refunded", "INV-003 partially paid".`;

async function telegramWebhook(env, ctx, request) {
  const update = await request.json().catch(() => ({}));

  if (update.callback_query) return telegramCallback(env, update.callback_query);

  const msg = update.message;
  if (!msg || !msg.text) return json({ ok: true }); // ignore non-text updates (edits, stickers, etc.)

  const chatId = String(msg.chat && msg.chat.id);
  if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.log("[telegram] ignored message from unauthorized chat_id " + chatId);
    return json({ ok: true }); // silently ignore — don't leak that this endpoint does anything
  }

  const statusMatch = msg.text.match(/^\s*(INV-\d+)\s+(.+)$/i);
  if (statusMatch) return telegramStatusUpdate(env, chatId, statusMatch[1].toUpperCase(), statusMatch[2]);

  return telegramNewBooking(env, chatId, msg.text);
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

    const preDiscount = await computeQuoteWithPromo(env, { event_type, venue_space, booking_date, hours });
    const disc = parseDiscount(fields["other"], preDiscount.grand_total);
    const q = await computeQuoteWithPromo(env, { event_type, venue_space, booking_date, hours, discount: disc.amount });

    const pendingData = {
      client_name: fields.name, client_phone: null, client_email: null, client_nric_uen,
      event_type, venue_space, booking_date, start_time, end_time,
      hours: q.hours, hourly_rate: q.hourly_rate, cleaning_fee: q.cleaning_fee,
      deposit_amount: q.deposit_amount, pet_fee: q.pet_fee,
      discount: q.discount, discount_note: disc.note || null,
      rental_total: q.rental_total, grand_total: q.grand_total,
      rental_fee_note: q.rental_fee_note, cleaning_fee_note: q.cleaning_fee_note,
      promo_clause_title: q.promo_clause_title, promo_clause_text: q.promo_clause_text, promo_id: q.promo_id,
      notes: fields.purpose || null,
    };
    const pendingId = await db.createPendingBooking(env, chatId, pendingData);

    const promoLine = q.promo_id ? `Promo applied: ${q.rental_fee_note || "yes"}\n` : "";
    const discountLine = q.discount > 0 ? `Extra discount: -$${q.discount.toFixed(2)} (${disc.note})\n` : (fields.other ? `⚠️ Couldn't parse "${fields.other}" as a discount — left at $0.\n` : "");
    await sendTelegram(env, chatId,
      `📋 Review booking for ${fields.name}\n` +
      `${event_type} · ${venue_space} · ${booking_date}${start_time ? " " + start_time : ""} (${hours}h)\n` +
      `Rental: $${q.rental_total.toFixed(2)}   Cleaning: $${q.cleaning_fee.toFixed(2)}\n` +
      promoLine + discountLine +
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
const STATUS_PHRASES = [
  { re: /deposit.*refund/i, apply: { deposit_status: "Refunded" }, refile: "deposit", label: "Deposit refunded" },
  { re: /clean(ing)?.*unpaid/i, apply: { cleaning_fee_status: "Unpaid" }, refile: "booking", label: "Cleaning fee marked unpaid" },
  { re: /deposit.*paid|paid.*deposit/i, apply: { deposit_status: "Held" }, refile: "deposit", label: "Deposit marked paid (held)" },
  { re: /clean(ing)?.*paid/i, apply: { cleaning_fee_status: "Paid" }, refile: "booking", label: "Cleaning fee marked paid" },
  { re: /partial/i, apply: { payment_status: "Partially Paid" }, refile: "booking", label: "Rental marked partially paid" },
  { re: /unpaid/i, apply: { payment_status: "Unpaid" }, refile: "booking", label: "Rental marked unpaid" },
  { re: /(booking|rental|final).*paid|paid.*(booking|rental)|^paid$/i, apply: { payment_status: "Paid" }, refile: "booking", label: "Booking marked fully paid" },
];

async function telegramStatusUpdate(env, chatId, invoiceNo, statusText) {
  const inv = await db.getInvoiceByNo(env, invoiceNo);
  if (!inv) {
    await sendTelegram(env, chatId, `⚠️ ${invoiceNo} not found.`);
    return json({ ok: true });
  }
  const match = STATUS_PHRASES.find((p) => p.re.test(statusText));
  if (!match) {
    await sendTelegram(env, chatId,
      `⚠️ Didn't recognize "${statusText}" for ${invoiceNo}. Try: "deposit paid", "booking paid", "cleaning paid", "deposit refunded", "partially paid".`);
    return json({ ok: true });
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
  } else {
    refileNote = "\n(Not yet signed — nothing to refile yet; status will show once it is.)";
  }

  await sendTelegram(env, chatId, `✅ ${invoiceNo}: ${match.label}.${refileNote}`);
  return json({ ok: true });
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

  // Discount can arrive either as free text to parse ("10% off") or an already-known
  // flat amount — the admin form sends text; the Telegram path could send either.
  let discount = b.discount, discountNote = b.discount_note || null;
  if ((discount === undefined || discount === null || discount === "") && b.discount_text) {
    const pre = await computeQuoteWithPromo(env, b);
    const parsed = parseDiscount(b.discount_text, pre.grand_total);
    discount = parsed.amount;
    discountNote = parsed.note || null;
  }

  const q = await computeQuoteWithPromo(env, { ...b, discount });
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
function docName(inv, kind) {
  const clean = String(inv.client_name || "client").replace(/[^A-Za-z0-9]+/g, "");
  return `${inv.invoice_no}_${kind}_${clean}_${inv.booking_date}.pdf`;
}
