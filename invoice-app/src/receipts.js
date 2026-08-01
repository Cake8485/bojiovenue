// Rental payment receipt (RRC) — Addendum 6, 2026-08-24. Filed once, the first time
// rental payment is confirmed via Telegram ("<booking> rental paid" — see worker.js's
// telegramStatusUpdate()). Shares essentially all of its line-item/summary logic
// with the Rental Invoice (INV) — same charges, same Zoho-matched "Money Document"
// identity — so the actual content builder lives in pdf.js's buildRentalMoneyDoc;
// this file just supplies the receipt-specific title/number-label/footer.
//
// The Security Deposit side has NO equivalent receipt file — see pdf.js's
// buildSecurityDepositPdf for why (one evolving SD document instead, matching
// Kenneth's real Zoho SD-xxxxx sample).

import { buildRentalMoneyDoc } from "./pdf.js";

export function buildRentalReceiptPdf(env, inv, payments = []) {
  return buildRentalMoneyDoc(env, inv, payments, { title: "Official Receipt", docNumberLabel: "Receipt", footer: "receipt", variant: "receipt" });
}
