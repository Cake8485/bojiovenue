// Server-side PDF builder (pdf-lib, pure JS — runs inside the Worker).
// Built server-side on purpose: the client can't tamper with totals/dates.
// Uses built-in Helvetica (no font files needed → smaller bundle).
//
// Two separate documents per signed booking (NOT one combined doc — Kenneth's real
// workflow keeps these apart): buildBookingInvoicePdf (rental + cleaning + pet fee,
// minus any discount — the main charge) and buildDepositInvoicePdf (the refundable
// security deposit only). Both carry the client's signature as proof of agreement,
// same as the signed Agreement itself (see agreement.js).

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const A4 = [595.28, 841.89];

function startDoc() {
  return PDFDocument.create();
}

async function shell(doc, inv, title) {
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();

  const dark = rgb(0.1, 0.1, 0.13);
  const gray = rgb(0.45, 0.45, 0.5);
  const rule = rgb(0.85, 0.85, 0.88);
  const M = 50;
  let y = height - M;

  const T = (s, x, yy, o = {}) =>
    page.drawText(String(s ?? ""), { x, y: yy, size: o.size ?? 10, font: o.f ?? font, color: o.color ?? dark });
  const R = (s, xRight, yy, o = {}) => {
    const f = o.f ?? font, size = o.size ?? 10;
    const w = f.widthOfTextAtSize(String(s ?? ""), size);
    page.drawText(String(s ?? ""), { x: xRight - w, y: yy, size, font: f, color: o.color ?? dark });
  };
  const hr = (yy) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: width - M, y: yy }, thickness: 0.75, color: rule });

  return { page, font, bold, width, height, dark, gray, rule, M, T, R, hr, y: () => y, setY: (v) => (y = v) };
}

const money = (n) => "$" + Number(n || 0).toFixed(2);
function round2(n) { return Math.round(n * 100) / 100; }
function kindLabel(k) {
  return { deposit: "Deposit", balance: "Balance", cleaning_fee: "Cleaning fee", refund: "Refund", other: "Payment" }[k] || k;
}

function drawHeader(ctx, env, inv, docTitle, statusLine) {
  const { T, R, hr, M, width, bold, gray } = ctx;
  let y = ctx.y();
  T(env.BUSINESS_NAME || "BojioVenue", M, y, { size: 20, f: bold });
  R(docTitle, width - M, y + 4, { size: 13, f: bold, color: gray });
  y -= 18;
  T(`${env.BUSINESS_OPERATOR || ""} · ${env.BUSINESS_ENTITY || ""}`, M, y, { size: 9, color: gray });
  R(inv.invoice_no, width - M, y, { size: 12, f: bold });
  y -= 12;
  T(`UEN ${env.BUSINESS_UEN || ""}`, M, y, { size: 9, color: gray });
  R(statusLine, width - M, y, { size: 8.5, color: gray });
  y -= 12;
  T(env.BUSINESS_ADDRESS || "", M, y, { size: 9, color: gray });
  y -= 20;
  hr(y);
  y -= 22;
  ctx.setY(y);

  const colB = width / 2;
  T("BILL TO", M, y, { size: 8, f: bold, color: gray });
  T("BOOKING", colB, y, { size: 8, f: bold, color: gray });
  y -= 15;
  T(inv.client_name, M, y, { size: 11, f: bold });
  T(`${inv.event_type} event · ${inv.venue_space}`, colB, y, { size: 10 });
  y -= 13;
  T(inv.client_phone || "", M, y, { size: 9, color: gray });
  T(`Date: ${inv.booking_date}`, colB, y, { size: 9, color: gray });
  y -= 12;
  T(inv.client_email || "", M, y, { size: 9, color: gray });
  const timeStr = inv.start_time ? `${inv.start_time}–${inv.end_time || ""}  (${inv.hours}h)` : `${inv.hours}h`;
  T(`Time: ${timeStr}`, colB, y, { size: 9, color: gray });
  y -= 24;
  ctx.setY(y);
}

async function drawSignature(ctx, doc, inv) {
  const { T, hr, M, rule } = ctx;
  let y = ctx.y();
  const sigTop = Math.max(y, 150);
  hr(sigTop); y = sigTop - 16;
  T("CLIENT ACKNOWLEDGEMENT & SIGNATURE", M, y, { size: 8, f: ctx.bold, color: ctx.gray });
  y -= 66;
  if (inv.signature_png) {
    try {
      const png = await doc.embedPng(inv.signature_png);
      const dims = png.scaleToFit(190, 60);
      ctx.page.drawImage(png, { x: M, y, width: dims.width, height: dims.height });
    } catch (e) {
      console.log("[pdf] signature embed failed: " + e);
    }
  }
  ctx.page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + 210, y: y - 4 }, thickness: 0.75, color: rule });
  T(inv.signer_name || inv.client_name || "", M, y - 16, { size: 9 });
  T(inv.signed_at ? `Signed: ${inv.signed_at} (SGT+/-)` : "Unsigned", M, y - 28, { size: 8, color: ctx.gray });
  ctx.setY(y - 28);
}

function drawFooter(ctx, text) {
  ctx.T(text, ctx.M, 40, { size: 8, color: ctx.gray });
}

// ---------------------------------------------------------------------------
// BOOKING INVOICE — rental + cleaning fee + pet fee, minus discount. The main charge.
// ---------------------------------------------------------------------------
export async function buildBookingInvoicePdf(env, inv, payments = []) {
  const doc = await startDoc();
  const ctx = await shell(doc, inv, "Booking Invoice");
  const { T, R, hr, M, width, bold, gray } = ctx;

  drawHeader(ctx, env, inv, "BOOKING INVOICE",
    `${inv.payment_status} · Cleaning: ${inv.cleaning_fee_status}`);
  let y = ctx.y();

  hr(y); y -= 15;
  T("DESCRIPTION", M, y, { size: 8, f: bold, color: gray });
  R("AMOUNT", width - M, y, { size: 8, f: bold, color: gray });
  y -= 16;
  T(`Venue rental — ${money(inv.hourly_rate)}/hr × ${inv.hours}h`, M, y);
  R(money(inv.rental_total), width - M, y);
  y -= 15;
  if (Number(inv.cleaning_fee) > 0) {
    T("Cleaning fee", M, y);
    R(money(inv.cleaning_fee), width - M, y);
    y -= 15;
  }
  if (Number(inv.pet_fee) > 0) {
    T("Pet cleaning fee", M, y);
    R(money(inv.pet_fee), width - M, y);
    y -= 15;
  }
  if (Number(inv.discount) > 0) {
    T(`Discount${inv.discount_note ? " (" + inv.discount_note + ")" : ""}`, M, y);
    R("-" + money(inv.discount), width - M, y);
    y -= 15;
  }
  y -= 3; hr(y); y -= 16;
  T("TOTAL", M, y, { size: 11, f: bold });
  R(money(inv.grand_total), width - M, y, { size: 11, f: bold });
  y -= 26;
  ctx.setY(y);

  const receivedTowardTotal = payments
    .filter((p) => p.kind === "balance" || p.kind === "cleaning_fee" || p.kind === "other")
    .reduce((s, p) => s + p.amount, 0);
  const balance = round2(inv.grand_total - receivedTowardTotal);

  const line = (label, val, strong = false) => {
    T(label, M, y, { size: 9, color: gray });
    R(val, width - M, y, { size: strong ? 11 : 10, f: strong ? bold : ctx.font });
    y -= 14;
  };
  T("PAYMENT SUMMARY", M, y, { size: 8, f: bold, color: gray });
  y -= 15;
  line("Total received", money(receivedTowardTotal));
  line("Balance outstanding", money(balance), true);
  line("Rental status", inv.payment_status);
  line("Cleaning fee status", inv.cleaning_fee_status);
  y -= 6;
  ctx.setY(y);

  const relevant = payments.filter((p) => p.kind === "balance" || p.kind === "cleaning_fee" || p.kind === "other");
  if (relevant.length) {
    y = ctx.y();
    hr(y); y -= 15;
    T("PAYMENT HISTORY", M, y, { size: 8, f: bold, color: gray });
    y -= 14;
    for (const p of relevant) {
      T(`${p.paid_on} · ${kindLabel(p.kind)}${p.note ? " · " + p.note : ""}`, M, y, { size: 9, color: gray });
      R(money(p.amount), width - M, y, { size: 9 });
      y -= 13;
    }
    y -= 6;
    ctx.setY(y);
  }

  await drawSignature(ctx, doc, inv);
  drawFooter(ctx, "Booking invoice — covers venue rental and cleaning fee. Not GST-registered — no GST applicable.");

  return await doc.save();
}

// ---------------------------------------------------------------------------
// DEPOSIT INVOICE — the refundable security deposit only. Separate document.
// ---------------------------------------------------------------------------
export async function buildDepositInvoicePdf(env, inv, payments = []) {
  const doc = await startDoc();
  const ctx = await shell(doc, inv, "Deposit Invoice");
  const { T, R, hr, M, width, bold, gray } = ctx;

  drawHeader(ctx, env, inv, "DEPOSIT INVOICE", `Deposit: ${inv.deposit_status}`);
  let y = ctx.y();

  hr(y); y -= 15;
  T("DESCRIPTION", M, y, { size: 8, f: bold, color: gray });
  R("AMOUNT", width - M, y, { size: 8, f: bold, color: gray });
  y -= 16;
  T("Refundable security deposit", M, y);
  R(money(inv.deposit_amount), width - M, y);
  y -= 15;
  y -= 3; hr(y); y -= 16;
  T("TOTAL", M, y, { size: 11, f: bold });
  R(money(inv.deposit_amount), width - M, y, { size: 11, f: bold });
  y -= 16;
  T("This deposit is fully refundable, subject to the terms of the signed Agreement", M, y, { size: 8.5, color: gray });
  y -= 12;
  T("(no damage, loss, excessive cleaning, or breach of House Rules).", M, y, { size: 8.5, color: gray });
  y -= 26;
  ctx.setY(y);

  const depositCollected = payments.filter((p) => p.kind === "deposit").reduce((s, p) => s + p.amount, 0);
  const depositRefunded = payments.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount, 0);
  const depositHeld = round2(depositCollected - depositRefunded);

  const line = (label, val, strong = false) => {
    T(label, M, y, { size: 9, color: gray });
    R(val, width - M, y, { size: strong ? 11 : 10, f: strong ? bold : ctx.font });
    y -= 14;
  };
  T("DEPOSIT STATUS", M, y, { size: 8, f: bold, color: gray });
  y -= 15;
  line("Deposit collected", money(depositCollected));
  line("Deposit refunded", money(depositRefunded));
  line("Currently held", money(depositHeld), true);
  line("Status", inv.deposit_status);
  y -= 6;
  ctx.setY(y);

  const relevant = payments.filter((p) => p.kind === "deposit" || p.kind === "refund");
  if (relevant.length) {
    y = ctx.y();
    hr(y); y -= 15;
    T("PAYMENT HISTORY", M, y, { size: 8, f: bold, color: gray });
    y -= 14;
    for (const p of relevant) {
      T(`${p.paid_on} · ${kindLabel(p.kind)}${p.note ? " · " + p.note : ""}`, M, y, { size: 9, color: gray });
      R(money(p.kind === "refund" ? -p.amount : p.amount), width - M, y, { size: 9 });
      y -= 13;
    }
    y -= 6;
    ctx.setY(y);
  }

  await drawSignature(ctx, doc, inv);
  drawFooter(ctx, "Deposit invoice — refundable security deposit, separate from the booking invoice.");

  return await doc.save();
}
