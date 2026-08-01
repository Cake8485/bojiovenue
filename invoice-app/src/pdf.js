// Rental money documents (Addendum 6, 2026-08-24) — INV (Invoice, frozen bill filed
// at signing) and the Security Deposit doc (SD, ONE evolving document re-filed in
// place as its Balance Due changes). Both use the Zoho-matched "Money Document"
// identity (brandingMoney.js) — a deliberately different visual identity from the
// Agreement/Deduction Addendum's blue/yellow/purple (branding.js).
//
// RRC (the rental Official Receipt) shares almost all of INV's line-item/summary
// logic — same charges, different title/doc-number-label/footer — so the shared
// content builder lives here (buildRentalMoneyDoc) and receipts.js just calls it
// with different presentation params. See schema.sql's Addendum 6 comment for why
// SD has no receipt counterpart (it's one evolving document, not an invoice+receipt
// pair, matching Kenneth's real Zoho SD-xxxxx samples).

import { isWeekend, SOCIAL_CLEANING_FEE, CORPORATE_CLEANING_FEE } from "./pricing.js";
import {
  startMoneyDoc, newMoneyPage, drawMoneyHeader, drawLineItemsTable, drawSummaryBlock, drawNotesBlock, drawTermsBlock, finishMoneyDoc,
} from "./brandingMoney.js";

function round2(n) { return Math.round(n * 100) / 100; }
function dateOnly(ts) { return ts ? String(ts).slice(0, 10) : "___________"; }

// Most recent payment matching any of `kinds` — payments arrive already sorted
// paid_on ASC/id ASC (see db.js's getPayments), so the last match is the latest.
function latestPaymentOf(payments, kinds) {
  const matches = (payments || []).filter((p) => kinds.includes(p.kind));
  return matches.length ? matches[matches.length - 1] : null;
}

function notesLines(payment) {
  if (!payment) return [];
  const lines = ["Payment Received."];
  if (payment.payment_mode) lines.push(`Payment Mode: ${payment.payment_mode}${payment.bank ? " (" + payment.bank + ")" : ""}`);
  if (payment.reference) lines.push(`Reference: ${payment.reference}`);
  return lines;
}

const RENTAL_TERMS = [
  "Deposit will be refunded within 5 to 7 working days after event, provided no damage, loss or breach of Agreement or House Rules has occured. Refer to Agreement Clause 8 for details.",
  "Overtime charges apply after 15 mins: Weekday $150/hr, Weekend $180/hr.",
  "Client and guests must comply with BoJioVenue Agreement and House Rules at all times.",
  "Damages, missing items, or excessive cleaning will be charged against the deposit or billed separately.",
];

const DEPOSIT_TERMS = [
  "Deposit will be refunded within 5 to 7 working days after the event, subject to inspection and house rules.",
  "Damages, missing items, or excessive cleaning will be charged against the deposit or billed separately.",
];

// Rental row's Rate/Discount/Amount differ by pricing engine — Social's rental_total
// is already net of discount_percent; Corporate/Seminar's rental_subtotal is GROSS
// (its flat $ discount is only subtracted at grand_total) — see pricing.js.
function rentalRowNumbers(inv) {
  if (inv.event_type === "Social") {
    return {
      rate: inv.rental_subtotal,
      discountDisplay: Number(inv.discount_percent) > 0 ? `${Number(inv.discount_percent).toFixed(2)}%` : "0.00",
      amount: inv.rental_total,
    };
  }
  const rate = inv.rental_subtotal ?? inv.rental_total;
  const amount = round2(Number(rate) - Number(inv.discount || 0));
  return {
    rate,
    discountDisplay: Number(inv.discount) > 0 ? Number(inv.discount).toFixed(2) : "0.00",
    amount,
  };
}

function rentalItemDescription(inv) {
  if (inv.event_type !== "Social") return `${inv.venue_space} Rental — ${inv.hours} Hours`;
  const weekend = isWeekend(inv.booking_date);
  return `${weekend ? "Weekends" : "Weekdays"} (${inv.hours} Hours) Package`;
}

function rentalItemSublines(inv) {
  const lines = [];
  if (inv.event_type === "Social" && isWeekend(inv.booking_date)) {
    lines.push("Include: Fri to Sun, Eve of PH & PH");
  }
  if (inv.rental_fee_note) {
    const pct = Number(inv.discount_percent) > 0 ? ` @ ${Number(inv.discount_percent).toFixed(0)}% off!` : "";
    lines.push(`${inv.rental_fee_note}${pct}`);
  }
  return lines;
}

// Cleaning-fee row's anchor Rate is the STANDARD fee for this event type ($80
// Social / $50 Corporate — Addendum 6's pricing-anchor fix, replacing the old
// Zoho receipt's incorrect $100), with Discount = anchor - actual charged, so the
// row always reads consistently regardless of WHY the actual differs (a promo
// override or a manual one-off) — anchor - discount = amount always holds.
function cleaningFeeRow(inv) {
  const anchor = inv.event_type === "Social" ? SOCIAL_CLEANING_FEE : CORPORATE_CLEANING_FEE;
  const actual = Number(inv.cleaning_fee || 0);
  const discount = Math.max(0, round2(anchor - actual));
  return {
    cells: { desc: "Cleaning Fee", qty: "1.00", rate: anchor.toFixed(2), discount: discount ? discount.toFixed(2) : "0.00", amount: actual.toFixed(2) },
    sublines: inv.cleaning_fee_note ? [inv.cleaning_fee_note] : [],
    bold: true,
    amount: actual,
  };
}

const RENTAL_COLUMNS = [
  { key: "num", label: "#", width: 20, align: "left" },
  { key: "desc", label: "Item & Description", width: 240, align: "left" },
  { key: "qty", label: "Qty", width: 40, align: "right" },
  { key: "rate", label: "Rate", width: 70, align: "right" },
  { key: "discount", label: "Discount", width: 70, align: "right" },
  { key: "amount", label: "Amount", width: 71, align: "right" },
];

// Shared by INV (buildRentalInvoicePdf) and RRC (receipts.js's buildRentalReceiptPdf)
// — same charges, different presentation. `paidKinds`: which payments.kind values
// count toward "Payment Made" (rental fee only — cleaning fee, if billed with
// rental, is logged as its own kind and is part of THIS document's total too, so
// both are included).
export async function buildRentalMoneyDoc(env, inv, payments, { title, docNumberLabel, footer, variant }) {
  const ctx = await startMoneyDoc();
  ctx.page = newMoneyPage(ctx.doc);

  const rows = [];
  const rn = rentalRowNumbers(inv);
  rows.push({
    cells: {
      num: "1", desc: rentalItemDescription(inv), qty: "1.00",
      rate: Number(rn.rate).toFixed(2), discount: rn.discountDisplay, amount: Number(rn.amount).toFixed(2),
    },
    sublines: rentalItemSublines(inv),
    bold: true,
    amount: rn.amount,
  });

  const cleaningOnThisDoc = (inv.cleaning_fee_with || "deposit") === "rental" && Number(inv.cleaning_fee) > 0;
  if (cleaningOnThisDoc) {
    const cf = cleaningFeeRow(inv);
    rows.push({ cells: { num: "2", ...cf.cells }, sublines: cf.sublines, bold: cf.bold, amount: cf.amount });
  }
  if (Number(inv.pet_fee) > 0) {
    rows.push({
      cells: { num: String(rows.length + 1), desc: "Pet Cleaning Fee", qty: "1.00", rate: Number(inv.pet_fee).toFixed(2), discount: "0.00", amount: Number(inv.pet_fee).toFixed(2) },
      sublines: [], bold: true, amount: Number(inv.pet_fee),
    });
  }

  const subTotal = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
  const paidKinds = cleaningOnThisDoc ? ["balance", "other", "cleaning_fee"] : ["balance", "other"];
  const paymentMade = round2(payments.filter((p) => paidKinds.includes(p.kind)).reduce((s, p) => s + Number(p.amount || 0), 0));
  const balanceDue = Math.max(0, round2(subTotal - paymentMade));

  let y = drawMoneyHeader(ctx, env, {
    layout: "rental",
    docTitle: title,
    docNumberLabel,
    docNumber: inv.booking_no,
    balanceDue,
    leftInfo:
      variant === "receipt"
        ? [
            { label: "Receipt Date :", value: dateOnly(inv.rental_paid_at) },
            { label: "Event Time :", value: inv.start_time ? `${inv.start_time} to ${inv.end_time || ""}` : "-" },
            { label: "Event Type :", value: inv.event_type },
          ]
        : [
            { label: "Invoice Date :", value: dateOnly(inv.signed_at || inv.created_at) },
            { label: "Event Date :", value: inv.booking_date },
            { label: "Event Type :", value: inv.event_type },
          ],
    client: { header: "Customer Details", name: inv.client_name, phone: inv.client_phone },
  });

  y = drawLineItemsTable(ctx, y, { columns: RENTAL_COLUMNS, rows: rows.map((r) => ({ cells: r.cells, sublines: r.sublines, bold: r.bold })) });
  y = drawSummaryBlock(ctx, y, { subTotal, total: subTotal, paymentMade, balanceDue });
  y = drawNotesBlock(ctx, y, notesLines(latestPaymentOf(payments, paidKinds)));
  drawTermsBlock(ctx, y, RENTAL_TERMS);

  finishMoneyDoc(ctx, { footer });
  return await ctx.doc.save();
}

export function buildRentalInvoicePdf(env, inv, payments = []) {
  return buildRentalMoneyDoc(env, inv, payments, { title: "Invoice", docNumberLabel: "Invoice", footer: "plain", variant: "invoice" });
}

// ---------------------------------------------------------------------------
// SECURITY DEPOSIT (SD) — ONE evolving document (Addendum 6). Filed at signing
// (unpaid) and re-filed IN PLACE (same filename) once "deposit paid" fires. Unlike
// rental, never gets a second "receipt" file — matches the real SD-00023.pdf
// sample, which stays titled "Deposit Invoice" even at Balance Due $0.00. Simpler
// 3-column table (#/Description/Amount only, no Qty/Rate/Discount) — also matches
// the real sample exactly.
// ---------------------------------------------------------------------------
const DEPOSIT_COLUMNS = [
  { key: "num", label: "#", width: 20, align: "left" },
  { key: "desc", label: "Description", width: 350, align: "left" },
  { key: "amount", label: "Amount", width: 141, align: "right" },
];

export async function buildSecurityDepositPdf(env, inv, payments = []) {
  const ctx = await startMoneyDoc();
  ctx.page = newMoneyPage(ctx.doc);

  const rows = [{ cells: { num: "1", desc: "Refundable Security Deposit", amount: Number(inv.deposit_amount || 0).toFixed(2) }, sublines: [], bold: true, amount: Number(inv.deposit_amount || 0) }];
  const cleaningOnThisDoc = (inv.cleaning_fee_with || "deposit") === "deposit" && Number(inv.cleaning_fee) > 0;
  if (cleaningOnThisDoc) {
    rows.push({
      cells: { num: "2", desc: "Cleaning Fee", amount: Number(inv.cleaning_fee || 0).toFixed(2) },
      sublines: inv.cleaning_fee_note ? [inv.cleaning_fee_note] : [],
      bold: true,
      amount: Number(inv.cleaning_fee || 0),
    });
  }

  const subTotal = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
  const paidKinds = cleaningOnThisDoc ? ["deposit", "cleaning_fee"] : ["deposit"];
  const paymentMade = round2(payments.filter((p) => paidKinds.includes(p.kind)).reduce((s, p) => s + Number(p.amount || 0), 0));
  const balanceDue = Math.max(0, round2(subTotal - paymentMade));

  let y = drawMoneyHeader(ctx, env, {
    layout: "deposit",
    docTitle: "Deposit Invoice",
    docNumberLabel: "Retainer",
    docNumber: inv.booking_no,
    balanceDue,
    leftInfo: [
      { label: "Deposit Date :", value: inv.deposit_paid_at ? dateOnly(inv.deposit_paid_at) : "Pending" },
      { label: "Event Date :", value: inv.booking_date },
    ],
    client: { header: "Bill To", name: inv.client_name, phone: inv.client_phone },
  });

  y = drawLineItemsTable(ctx, y, { columns: DEPOSIT_COLUMNS, rows: rows.map((r) => ({ cells: r.cells, sublines: r.sublines, bold: r.bold })) });
  y = drawSummaryBlock(ctx, y, { subTotal, total: subTotal, paymentMade, balanceDue });
  y = drawNotesBlock(ctx, y, notesLines(latestPaymentOf(payments, paidKinds)));
  drawTermsBlock(ctx, y, DEPOSIT_TERMS);

  finishMoneyDoc(ctx, { footer: "plain" });
  return await ctx.doc.save();
}
