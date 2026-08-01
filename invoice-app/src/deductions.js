// Security Deposit Deduction Addendum (Addendum 4, 2026-08-17) — Clause 8.3/8.4 of
// the signed Agreement. Mirrors agreement.js's own approach exactly: one content
// array, rendered two ways (HTML for the /addendum acknowledgment page, PDF for the
// filed record), reusing branding.js's shared sky-blue/yellow-card design and the
// SAME two-column signature-block layout as the Agreement — Kenneth described this
// as using "the SAME link-signing system as the agreement," not a lighter
// tap-to-acknowledge flow, so the client draws a real signature here too.
//
// A booking can have more than one deduction (see schema.sql), so "balance
// refundable" on any given addendum is a RUNNING balance: original deposit, minus
// every deduction up to and including this one, in the order they were filed.

import { startBrandedDoc, drawBrandedCards, drawPageFooters, roundedRectPath, COLOR_TEXT, COLOR_CARD, M } from "./branding.js";

const money = (n) => "$" + Number(n || 0).toFixed(2);

// `priorDeductionsTotal`: sum of every OTHER deduction on this booking filed
// before this one (excludes this deduction's own amount).
function deductionContent(env, invoice, deduction, priorDeductionsTotal) {
  const balanceAfter = Math.max(0, Number(invoice.deposit_amount || 0) - Number(priorDeductionsTotal || 0) - Number(deduction.amount || 0));
  return [
    { newCard: true, p: `Security Deposit Deduction Addendum, issued under Clause 8.3 of the signed Agreement for booking ${invoice.booking_no}.` },
    { p: `Between: ${env.BUSINESS_ENTITY || "Novan Management"} (trading as ${env.BUSINESS_NAME || "BojioVenue"}) and ${invoice.client_name} (the "Client").` },
    { p: `Event Date: ${invoice.booking_date}` },

    { newCard: true, h: "Nature of Breach / Remarks" },
    { p: deduction.reason },

    { newCard: true, h: "Deduction" },
    { p: `Deduction Amount: ${money(deduction.amount)}` },
    { p: `Original Security Deposit: ${money(invoice.deposit_amount)}` },
    ...(Number(priorDeductionsTotal) > 0 ? [{ p: `Prior Deductions Already Filed on This Booking: ${money(priorDeductionsTotal)}` }] : []),
    { p: `Balance Refundable: ${money(balanceAfter)}`, bold: true },

    { newCard: true, h: "8.4 Payment of Balance" },
    { p: "Where a deduction applies, the balance of the security deposit (if any) shall be refunded within three (3) working days after this Addendum has been signed and acknowledged by the Client." },
  ];
}

export function deductionTitle() {
  return "Security Deposit Deduction Addendum";
}

// ---------------------------------------------------------------------------
// HTML rendering for the /addendum page — same block-to-markup mapping as
// agreement.js's agreementHtml().
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function deductionHtml(env, invoice, deduction, priorDeductionsTotal) {
  const blocks = deductionContent(env, invoice, deduction, priorDeductionsTotal);
  let html = "";
  let cardOpen = false;
  for (const b of blocks) {
    if (b.newCard) {
      if (cardOpen) html += "</div>";
      html += '<div class="a-card">';
      cardOpen = true;
    }
    if (b.h) html += `<h3>${esc(b.h)}</h3>`;
    else html += `<p${b.bold ? ' class="a-bold"' : ""}>${esc(b.p)}</p>`;
  }
  if (cardOpen) html += "</div>";
  return html;
}

// ---------------------------------------------------------------------------
// PDF rendering — only ever called after acknowledgment (see worker.js), so the
// signature block always has real data; written generally like agreement.js's
// buildAgreementPdf in case a future "preview before acknowledgment" need comes up.
// ---------------------------------------------------------------------------
export async function buildDeductionAddendumPdf(env, invoice, deduction, priorDeductionsTotal) {
  const { doc, font, bold, titleFont, logoImg } = await startBrandedDoc();
  const blocks = deductionContent(env, invoice, deduction, priorDeductionsTotal);
  let { pages, page, y, contentW, newPage } = drawBrandedCards({ doc, font, bold, titleFont, logoImg, title: deductionTitle().toUpperCase(), blocks });

  const sigH = 150;
  if (y - sigH < 52) {
    ({ page, y } = newPage());
  }
  const sigTop = y;
  page.drawSvgPath(roundedRectPath(contentW, sigH, 10), { x: M, y: sigTop, color: COLOR_CARD });
  let sy = sigTop - 14 - 9;
  page.drawText("Acknowledged by the Client:", { x: M + 14, y: sy, size: 10, font: bold, color: COLOR_TEXT });
  sy -= 26;
  const colL = M + 14, colR = M + contentW / 2 + 10;
  if (deduction.signature_png) {
    try {
      const png = await doc.embedPng(deduction.signature_png);
      const dims = png.scaleToFit(180, 50);
      page.drawImage(png, { x: colR, y: sy - 40, width: dims.width, height: dims.height });
    } catch (e) {
      console.log("[deductions] signature embed failed: " + e);
    }
  }
  sy -= 46;
  page.drawLine({ start: { x: colL, y: sy }, end: { x: colL + 200, y: sy }, thickness: 0.75, color: COLOR_TEXT });
  page.drawLine({ start: { x: colR, y: sy }, end: { x: colR + 200, y: sy }, thickness: 0.75, color: COLOR_TEXT });
  sy -= 14;
  page.drawText(`For and on behalf of ${env.BUSINESS_NAME || "BojioVenue"} (${env.BUSINESS_ENTITY || "Novan Mgt"})`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText("Client's Signature", { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });
  sy -= 13;
  const ackDate = deduction.acknowledged_at ? deduction.acknowledged_at.slice(0, 10) : "___________";
  page.drawText(`Date: ${ackDate}`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText(`Date: ${ackDate}`, { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });
  sy -= 16;
  page.drawText(`Contact Person: ${env.BUSINESS_OPERATOR || "Kenneth Lu"} (Operation Manager)`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText(deduction.acknowledger_name ? `Signed by: ${deduction.acknowledger_name}` : "Unacknowledged", { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });

  drawPageFooters(pages, font);
  return await doc.save();
}
