// Payment receipts (added Addendum 3, 2026-08-10) — distinct from the Booking
// Invoice / Deposit Invoice in pdf.js. Invoice = bill (what's owed, generated at
// signing). Receipt = proof of payment ACTUALLY received, generated only once
// Kenneth confirms the corresponding payment via Telegram ("INV-XXX rental paid" /
// "INV-XXX deposit paid") — see worker.js's telegramStatusUpdate(). Two payment
// events, two receipts:
//   Receipt #1 — rental fee (confirms the booking)
//   Receipt #2 — security deposit + cleaning fee (due 7 days before the event)
// Uses the same branded sky-blue/yellow-card design as the Agreement (branding.js)
// per Kenneth's request, not the plain-Helvetica style of the older invoice PDFs.
// No PayNow QR here — a receipt documents money already received, not owed; the QR
// lives on the Booking/Deposit Invoice PDFs instead (see pdf.js).

import { startBrandedDoc, drawBrandedCards, drawPageFooters } from "./branding.js";
import { isWeekend } from "./pricing.js";

const money = (n) => "$" + Number(n || 0).toFixed(2);
const noteSuffix = (note) => (note ? ` (${note})` : "");
const dateOnly = (ts) => (ts ? String(ts).slice(0, 10) : "___________");

// Same breakdown shown on the Agreement for Social bookings, restated here as "paid"
// rather than "owed" — keeps the receipt legible on its own without the Agreement.
function socialBreakdownLines(inv) {
  const dayLabel = isWeekend(inv.booking_date) ? "Weekend" : "Weekday";
  const lines = [
    { p: `Usual Rate: ${money(inv.usual_rate)}/hr (${dayLabel})` },
    { p: `Package Rate: ${money(inv.hourly_rate)}/hr${noteSuffix(inv.rental_fee_note)}` },
    { p: `Rental Subtotal: ${money(inv.hourly_rate)} × ${inv.hours}h = ${money(inv.rental_subtotal)}` },
  ];
  if (Number(inv.discount_percent) > 0) {
    lines.push({ p: `Discount: ${inv.discount_percent}% (-${money(inv.discount)})` });
  }
  return lines;
}

function header(inv) {
  return [
    { newCard: true, p: `Received with thanks from ${inv.client_name} (the "Client").` },
    { p: `Booking: ${inv.invoice_no} · ${inv.event_type} event · ${inv.venue_space}` },
    { p: `Event Date: ${inv.booking_date}${inv.start_time ? ` · ${inv.start_time}–${inv.end_time || ""}` : ""} (${inv.hours}h)` },
  ];
}

function paymentFooterLines(env, paidAt) {
  return [
    { p: `Payment Date: ${dateOnly(paidAt)}` },
    { p: `Payment Method: PayNow to UEN ${env.BUSINESS_UEN || ""} (${env.BUSINESS_ENTITY || "Novan Management"})` },
  ];
}

function rentalReceiptContent(env, inv) {
  const rentalLines = inv.event_type === "Social" ? socialBreakdownLines(inv) : [];
  return [
    ...header(inv),
    { newCard: true, h: "Rental Fee" },
    ...rentalLines,
    { p: `Rental Fee Paid: ${money(inv.rental_total)}`, bold: true },
    ...paymentFooterLines(env, inv.rental_paid_at),
    { newCard: true, p: "This receipt confirms the rental fee only. The security deposit and cleaning fee are billed and receipted separately." },
  ];
}

function depositReceiptContent(env, inv) {
  return [
    ...header(inv),
    { newCard: true, h: "Security Deposit & Cleaning Fee" },
    { p: `Security Deposit: ${money(inv.deposit_amount)} (refundable)${noteSuffix(inv.deposit_note)}` },
    { p: `Cleaning Fee: ${money(inv.cleaning_fee)}${noteSuffix(inv.cleaning_fee_note)}` },
    { p: `Total Received: ${money(Number(inv.deposit_amount || 0) + Number(inv.cleaning_fee || 0))}`, bold: true },
    ...paymentFooterLines(env, inv.deposit_paid_at),
    { newCard: true, p: "The security deposit is fully refundable, subject to the terms of the signed Agreement (no damage, loss, excessive cleaning, or breach of House Rules). The cleaning fee is non-refundable." },
  ];
}

async function buildReceiptPdf(title, blocks) {
  const { doc, font, bold, titleFont, logoImg } = await startBrandedDoc();
  const { pages } = drawBrandedCards({ doc, font, bold, titleFont, logoImg, title, blocks });
  drawPageFooters(pages, font);
  return await doc.save();
}

export async function buildRentalReceiptPdf(env, inv) {
  return buildReceiptPdf("RENTAL PAYMENT RECEIPT", rentalReceiptContent(env, inv));
}

export async function buildDepositReceiptPdf(env, inv) {
  return buildReceiptPdf("DEPOSIT & CLEANING FEE RECEIPT", depositReceiptContent(env, inv));
}
