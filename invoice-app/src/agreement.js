// Agreement Generator. Content matches Kenneth's actual current live template,
// confirmed against a real signed agreement (Agreement for Nirmala.pdf, read
// 2026-07-27) — this superseded an earlier transcription from an older PDF that
// had a few structural gaps (merged clauses, an outdated 30-day payment window,
// a less detailed Security Deposit section). Template picked by venue_space:
// Whole Venue -> the general/Novan Management agreement, Main Hall Only -> the
// Seminar/Training Room agreement (matches which facilities are included).
//
// One content array is the single source of truth, rendered two ways:
//   - agreementHtml(): shown on the /sign page for the client to read + sign
//   - buildAgreementPdf(): paginated, styled PDF (pdf-lib), filed to Drive after signing
//
// Each block may set `newCard: true` to start a new visual card in the PDF/HTML
// (the reference design uses one yellow rounded card per logical section — see
// buildAgreementPdf). The very first card (parties) intentionally has no heading,
// matching the reference exactly.
//
// PROMO / CUSTOM CLAUSE MECHANISM (added 2026-07-27, per addendum):
// A promotional rate is just a manually-overridden rental_fee/cleaning_fee/deposit
// (already supported) plus an optional label shown in parentheses next to the
// amount (b.rental_fee_note / b.cleaning_fee_note / b.deposit_note). A promo can
// also carry its own override clause (b.promo_clause_title / b.promo_clause_text),
// inserted as clause 5.6, immediately after the standard cancellation terms —
// matching exactly how Kenneth's real "SG61 x BoJio Turns One Promo" clause works.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { barlowBoldFont, logoPng } from "./assets.js";

const money = (n) => "$" + Number(n || 0).toFixed(2);
const noteSuffix = (note) => (note ? ` (${note})` : "");

function wholeVenueContent(env, b) {
  const grandTotal = Number(b.rental_total || 0) + Number(b.deposit_amount || 0) + Number(b.cleaning_fee || 0) + Number(b.pet_fee || 0);
  return [
    { newCard: true, p: "This Agreement is made on the date of signature between:" },
    { p: `1. ${env.BUSINESS_ENTITY || "Novan Management"} (UEN: ${env.BUSINESS_UEN || ""})` },
    { p: `Trading as: ${env.BUSINESS_NAME || "BojioVenue"} (the "Venue")` },
    { p: `Address: ${env.BUSINESS_ADDRESS || ""}` },
    { p: `2. Client's Name: ${b.client_name} (the "Client")` },
    { p: `NRIC / UEN: ${b.client_nric_uen || "___________"}` },
    { p: `Contact No.: ${b.client_phone || "___________"}    Email: ${b.client_email || "___________"}` },

    { newCard: true, h: "1. Purpose" },
    { p: `The Venue, operated by ${env.BUSINESS_ENTITY || "Novan Management"} (UEN: ${env.BUSINESS_UEN || ""}) under the brand name ${env.BUSINESS_NAME || "BojioVenue"}, agrees to provide the Client with rental of the event space for the agreed date and time, subject to the terms and conditions of this Agreement.` },

    { newCard: true, h: "2. Event Details" },
    { p: `Event Date: ${b.booking_date}` },
    { p: `Event Time: From ${b.start_time || "___"} to ${b.end_time || "___"} (${b.hours} Hours)` },
    { p: "(Teardown must be completed within booked rental hours.)" },
    { p: "Complimentary setup time: 30 min provided in addition to rental hours. (This is out of goodwill and also depends on the bookings ahead of yours.)" },
    { p: `Event Purpose: ${b.notes || b.event_type}` },
    { p: `Rental Fee: ${money(b.rental_total)}${noteSuffix(b.rental_fee_note)}${b.promo_clause_text ? " Refer to Clause 5.6" : ""}` },
    { p: `- Security Deposit: ${money(b.deposit_amount)} (refundable, subject to Clause 8)${noteSuffix(b.deposit_note)}` },
    { p: `- Cleaning Fee: ${money(b.cleaning_fee)}${noteSuffix(b.cleaning_fee_note)}` },
    ...(Number(b.pet_fee) > 0 ? [{ p: `- Pet Cleaning Fee: ${money(b.pet_fee)}${noteSuffix(b.pet_fee_note)}` }] : []),
    { p: `Grand Total: ${money(grandTotal)}, payable to PayNow UEN: ${env.BUSINESS_UEN || ""} (${env.BUSINESS_ENTITY || "Novan Management"})` },

    { newCard: true, h: "3. Booking and Payment" },
    { p: "3.1 The booking is confirmed upon receipt of full payment of the rental fee, payable to Novan Management. The security deposit and any applicable cleaning fees must be paid no later than seven (7) days before the event date, unless otherwise stated in Clause 2." },
    { p: "3.2 The Venue reserves the right to cancel any unconfirmed booking without liability." },

    { newCard: true, h: "4. Overtime Charges" },
    { p: "4.1 The Client must vacate the Venue by the agreed time." },
    { p: "4.2 Any overrun exceeding fifteen (15) minutes will be charged as an additional full hour at the following rates: Weekdays $150 per hour, Weekends $180 per hour." },

    { newCard: true, h: "5. Cancellation and Postponement" },
    { p: "5.1 Cancellation more than six (6) weeks before the event: Full refund." },
    { p: "5.2 Cancellation three (3) to six (6) weeks before the event: 50% of the rental fee will be forfeited." },
    { p: "5.3 Cancellation less than three (3) weeks before the event: No refund." },
    { p: "5.4 Postponement more than four (4) weeks before the event: One (1) complimentary date change subject to availability." },
    { p: "5.5 Postponement four (4) weeks or less before the event: $50 administrative fee applies." },
    ...(b.promo_clause_text
      ? [{ p: `5.6 ${b.promo_clause_title || "Special Promotion Terms"}`, bold: true }, { p: b.promo_clause_text }]
      : []),

    { newCard: true, h: "6. Use of Venue" },
    { p: "6.1 The Venue shall be used solely for the stated purpose and during the agreed time." },
    { p: "6.2 The Client is responsible for ensuring that all attendees, vendors, and service providers comply with the Venue's House Rules (separate document)." },
    { p: "6.3 The Client shall not permit any unlawful activity or conduct likely to damage the Venue's reputation or property." },
    { p: "6.4 Smoking & Illegal Activities. Smoking or vaping is strictly prohibited inside the Venue at all times. Smoking is permitted only in designated outdoor smoking areas. Any breach of this clause, including indoor smoking, vaping, littering of cigarette butts, outside corridor areas, will result in deductions from the security deposit as stipulated in the Venue's House Rules." },
    { p: "6.5 The Client shall ensure that all attendees comply with Singapore laws and regulations, including those relating to smoking, alcohol consumption, and public safety. Any illegal activity shall be solely the responsibility of the Client and attendees. The Venue and Novan Management shall bear no liability, and matters involving illegal conduct will be referred to the relevant authorities where necessary." },

    { newCard: true, h: "7. Liability and Indemnity" },
    { p: "7.1 The Client shall be liable for any damage, loss, or excessive cleaning required as a result of the event." },
    { p: "7.2 If the total cost of repairs or cleaning exceeds the security deposit, the Client shall pay the difference within seven (7) days of receiving the invoice issued by Novan Management." },
    { p: "7.3 The Venue is not responsible for personal injury, loss, or damage to personal property occurring during the event." },

    { newCard: true, h: "8. Security Deposit" },
    { p: "8.1 The security deposit will be refunded within five (5) to seven (7) working days after the event, provided no damage, loss, or breach of this Agreement or House Rules has occurred." },
    { p: "8.2 Deductions may be made for: damage to property or equipment, excessive cleaning requirements, unreturned or lost keys, any breach of this Agreement or the Venue's House Rules." },
    { p: "8.3 In the event that any deduction is required, the Venue shall issue a Security Deposit Deduction Addendum detailing the nature of the breach, supporting remarks, and the deduction amount." },
    { p: "8.4 Where deductions apply, the balance of the security deposit (if any) shall be refunded within three (3) working days after the Security Deposit Deduction Addendum has been signed and acknowledged by the Client." },
    { p: "8.5 If the total amount of damages, penalties, or charges exceeds the security deposit, the Client shall pay the outstanding balance within seven (7) days of receiving the invoice issued by Novan Management." },

    { newCard: true, h: "9. Force Majeure" },
    { p: "The Venue shall not be held liable for failure to perform its obligations under this Agreement due to events beyond its reasonable control, including but not limited to government restrictions, natural disasters, or other emergencies. In such cases, the Venue may reschedule the event or provide a credit valid for twelve (12) months." },

    { newCard: true, h: "10. Governing Law" },
    { p: "This Agreement shall be governed by and construed in accordance with the laws of Singapore. The parties submit to the exclusive jurisdiction of the courts of Singapore." },

    { newCard: true, h: "11. Entire Agreement" },
    { p: "This Agreement, together with the Venue's House Rules (separate document), constitutes the entire agreement between the parties and supersedes all prior discussions or understandings." },
  ];
}

function mainHallContent(env, b) {
  const grandTotal = Number(b.rental_total || 0) + Number(b.deposit_amount || 0) + Number(b.cleaning_fee || 0) + Number(b.pet_fee || 0);
  return [
    { newCard: true, p: "This Agreement is made on the date of signature between:" },
    { p: `1. ${env.BUSINESS_NAME || "BojioVenue"} (the "Venue")` },
    { p: `Address: ${env.BUSINESS_ADDRESS || ""}` },
    { p: "Contact No.: 85099176" },
    { p: `2. Client's Name: ${b.client_name} (the "Client")` },
    { p: `NRIC: ${b.client_nric_uen || "___________"}` },
    { p: `Contact No.: ${b.client_phone || "___________"}    Email: ${b.client_email || "___________"}` },

    { newCard: true, h: "1. Purpose" },
    { p: `The Venue agrees to provide the Client with rental of the designated training space (Main Hall Only) for seminar, meeting, or training purposes, subject to the terms of this Agreement.` },

    { newCard: true, h: "2. Booking Details" },
    { p: "Room Booked: Main Hall Only" },
    { p: `Date: ${b.booking_date}` },
    { p: `Time: From ${b.start_time || "___"} to ${b.end_time || "___"} (${b.hours} Hours, includes setup and teardown)` },
    { p: "Complimentary setup time: 15 min provided in addition to rental hours. (This is out of goodwill and also depends on the bookings ahead of yours.)" },
    { p: `Purpose: ${b.notes || b.event_type}` },
    { p: `Rental Fee: ${money(b.rental_total)}${noteSuffix(b.rental_fee_note)}${b.promo_clause_text ? " Refer to Clause 4.6" : ""}` },
    { p: `- Security Deposit: ${money(b.deposit_amount)} (Refundable, see Clause 7)${noteSuffix(b.deposit_note)}` },
    { p: `- Cleaning Fee: ${money(b.cleaning_fee)} (Non-refundable)${noteSuffix(b.cleaning_fee_note)}` },
    ...(Number(b.pet_fee) > 0 ? [{ p: `- Pet Cleaning Fee: ${money(b.pet_fee)}${noteSuffix(b.pet_fee_note)}` }] : []),
    { p: `Grand Total: ${money(grandTotal)}, payable to PayNow UEN: ${env.BUSINESS_UEN || ""} (${env.BUSINESS_ENTITY || "Novan Management"})` },

    { newCard: true, h: "3. Facilities Included" },
    { p: "Rental includes use of: Tables & chairs, TV screen / Projector, Wi-Fi, Water dispenser, Toilet access. No use of entertainment facilities (KTV system, pool table, darts, arcade, etc.) is included." },

    { newCard: true, h: "4. Booking and Payment" },
    { p: "4.1 Booking is only confirmed upon receipt of full payment of the rental fee. The security deposit and any applicable cleaning fees must be paid no later than seven (7) days before the event date." },
    { p: "4.2 For bookings within seven (7) days of the event date, full payment must be made immediately." },
    { p: "4.3 Unconfirmed bookings may be cancelled by the Venue without liability." },
    ...(b.promo_clause_text
      ? [{ p: `4.6 ${b.promo_clause_title || "Special Promotion Terms"}`, bold: true }, { p: b.promo_clause_text }]
      : []),

    { newCard: true, h: "5. Cancellation and Postponement" },
    { p: "More than 3 weeks' notice: 100% refund. 1-3 weeks' notice: 50% refund. Less than 1 week: No refund. One (1) complimentary postponement allowed if notified at least 14 days prior, subject to availability." },

    { newCard: true, h: "6. Use of Venue" },
    { p: "6.1 Venue shall be used solely for the stated purpose and during the agreed time." },
    { p: "6.2 No loud music and usage of entertainment facilities allowed." },
    { p: "6.3 Client shall not permit any unlawful activity or conduct likely to damage the Venue's reputation or property." },
    { p: "6.4 Client must ensure all attendees comply with BoJioVenue House Rules." },

    { newCard: true, h: "7. Security Deposit" },
    { p: "7.1 The security deposit will be refunded within five (5) to seven (7) working days after the event, provided no damage, loss, or breach of this Agreement or House Rules has occurred." },
    { p: "7.2 Deductions may be made for: damage to property or equipment, excessive cleaning requirements, unreturned or lost keys, any breach of this Agreement or the Venue's House Rules." },
    { p: "7.3 If the total cost of repairs or cleaning exceeds the security deposit, the Client shall pay the difference within seven (7) days of receiving the invoice." },

    { newCard: true, h: "8. Liability" },
    { p: "The Venue shall not be responsible for any injury, loss, or property damage occurring during use of the premises. The Client shall indemnify the Venue against any claims arising from their event or participants' actions." },

    { newCard: true, h: "9. Force Majeure" },
    { p: "If the event cannot proceed due to government restrictions or unforeseen circumstances, the Venue may reschedule or issue a credit valid for 12 months." },

    { newCard: true, h: "10. Governing Law" },
    { p: "This Agreement shall be governed by and construed in accordance with the laws of Singapore." },

    { newCard: true, h: "11. Entire Agreement" },
    { p: "This Agreement, together with the Venue's House Rules (separate document), constitutes the entire agreement between the parties and supersedes all prior discussions or understandings." },
  ];
}

export function agreementContent(env, booking) {
  return booking.venue_space === "Main Hall Only" ? mainHallContent(env, booking) : wholeVenueContent(env, booking);
}

export function agreementTitle(booking) {
  return booking.venue_space === "Main Hall Only" ? "Seminar / Training Room Rental Agreement" : "Event Space Rental Agreement";
}

// ---------------------------------------------------------------------------
// HTML rendering for the /sign page.
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function agreementHtml(env, booking) {
  const blocks = agreementContent(env, booking);
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
// PDF rendering — paginated, styled to match the reference design:
// sky-blue page, yellow rounded cards per section, deep-purple header/footer
// bars, logo top-left, "Page X of Y" footer. pdf-lib has no built-in text flow
// or rounded-rect primitive, so both are hand-rolled below.
// ---------------------------------------------------------------------------
const COLOR_BG = rgb(0.576, 0.776, 0.851); // #93C6D9 sky blue
const COLOR_CARD = rgb(1, 0.871, 0.345); // #FFDE58 yellow
const COLOR_FRAME = rgb(0.247, 0.126, 0.361); // #3F205C deep purple
const COLOR_TEXT = rgb(0.184, 0.043, 0.365); // #2F0B5D purple body text
const A4 = [595.28, 841.89];
const M = 42; // page margin outside the frame
const BAR_H = 22; // top/bottom purple bar height
const CARD_PAD = 14;
const CARD_GAP = 12;

function wrapText(font, size, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Rounded rectangle via SVG path (pdf-lib has no native rounded-rect primitive).
// pdf-lib's drawSvgPath treats the path as LOCAL coordinates anchored at the {x,y}
// passed in its options, with Y increasing DOWNWARD (SVG convention) — NOT absolute
// PDF page coordinates. So this path is built relative to (0,0) = top-left of the
// rect, extending right by `w` and DOWN by `h`; the caller passes the rect's
// top-left PDF coordinate as the drawSvgPath `x`/`y` option.
function roundedRectPath(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

export async function buildAgreementPdf(env, booking, logoImageBytes) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titleFont = await doc.embedFont(barlowBoldFont); // real Barlow Bold, bundled — see src/assets.js

  const contentW = A4[0] - 2 * M;
  const maxTextW = contentW - 2 * CARD_PAD;

  // Defaults to the bundled BojioVenue logo (with its cream background box, per
  // Kenneth's confirmation — "use the existing file as-is") unless a different
  // image is explicitly passed in.
  const logoBytes = logoImageBytes || logoPng;
  let logoImg = null;
  if (logoBytes) {
    const bytes = new Uint8Array(logoBytes);
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = PNG_SIG.every((byte, i) => bytes[i] === byte);
    try {
      logoImg = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch (e) {
      console.log("[agreement] logo embed failed: " + e);
    }
  }

  const blocks = agreementContent(env, booking);
  const title = agreementTitle(booking).toUpperCase();

  // Pre-measure each block's wrapped lines so we know each card's height before
  // drawing its background (drawn back-to-front: card fill, then text on top).
  const measured = blocks.map((b) => {
    if (b.h) return { ...b, lines: [b.h], size: 10.5, isHeading: true };
    const lines = wrapText(font, 9.5, b.p, maxTextW);
    return { ...b, lines, size: 9.5, isHeading: false };
  });

  // Group into cards (each starts at a newCard block).
  const cards = [];
  for (const blk of measured) {
    if (blk.newCard || cards.length === 0) cards.push([]);
    cards[cards.length - 1].push(blk);
  }

  let pageNum = 0;
  const pages = [];
  let page, y;

  function newPage() {
    pageNum++;
    page = doc.addPage(A4);
    pages.push(page);
    page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: COLOR_BG });
    page.drawRectangle({ x: 0, y: A4[1] - BAR_H, width: A4[0], height: BAR_H, color: COLOR_FRAME });
    page.drawRectangle({ x: 0, y: 0, width: A4[0], height: BAR_H, color: COLOR_FRAME });
    if (logoImg) {
      const dims = logoImg.scaleToFit(120, 40);
      page.drawImage(logoImg, { x: M, y: A4[1] - BAR_H - 16 - dims.height, width: dims.width, height: dims.height });
    }
    const titleX = logoImg ? M + 130 : M;
    page.drawText(title, { x: titleX, y: A4[1] - BAR_H - 40, size: 19, font: titleFont, color: rgb(0, 0, 0) });
    y = A4[1] - BAR_H - 70;
  }
  newPage();

  const cardHeight = (card) => {
    let h = CARD_PAD * 2;
    for (const blk of card) h += blk.lines.length * (blk.isHeading ? 15 : 13) + (blk.isHeading ? 4 : 3);
    return h;
  };

  for (const card of cards) {
    const h = cardHeight(card);
    if (y - h < BAR_H + 30) newPage();
    const cardTop = y;
    const cardY = cardTop - h;
    page.drawSvgPath(roundedRectPath(contentW, h, 10), { x: M, y: cardTop, color: COLOR_CARD });
    let ty = cardTop - CARD_PAD - 9;
    for (const blk of card) {
      const f = blk.isHeading || blk.bold ? bold : font;
      for (const line of blk.lines) {
        page.drawText(line, { x: M + CARD_PAD, y: ty, size: blk.size, font: f, color: COLOR_TEXT });
        ty -= blk.isHeading ? 15 : 13;
      }
      ty -= blk.isHeading ? 4 : 3;
    }
    y = cardY - CARD_GAP;
  }

  // Signature block — two columns, matching the reference: Venue rep (typed, not
  // signed — Kenneth issues these himself) on the left, Client's captured signature
  // on the right.
  const sigH = 150;
  if (y - sigH < BAR_H + 30) newPage();
  const sigTop = y;
  page.drawSvgPath(roundedRectPath(contentW, sigH, 10), { x: M, y: sigTop, color: COLOR_CARD });
  let sy = sigTop - CARD_PAD - 9;
  page.drawText("Signed by the Parties:", { x: M + CARD_PAD, y: sy, size: 10, font: bold, color: COLOR_TEXT });
  sy -= 26;
  const colL = M + CARD_PAD, colR = M + contentW / 2 + 10;
  if (booking.signature_png) {
    try {
      const png = await doc.embedPng(booking.signature_png);
      const dims = png.scaleToFit(180, 50);
      page.drawImage(png, { x: colR, y: sy - 40, width: dims.width, height: dims.height });
    } catch (e) {
      console.log("[agreement] signature embed failed: " + e);
    }
  }
  sy -= 46;
  page.drawLine({ start: { x: colL, y: sy }, end: { x: colL + 200, y: sy }, thickness: 0.75, color: COLOR_TEXT });
  page.drawLine({ start: { x: colR, y: sy }, end: { x: colR + 200, y: sy }, thickness: 0.75, color: COLOR_TEXT });
  sy -= 14;
  page.drawText(`For and on behalf of ${env.BUSINESS_NAME || "BojioVenue"} (${env.BUSINESS_ENTITY || "Novan Mgt"})`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText("Client's Signature", { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });
  sy -= 13;
  page.drawText(`Date: ${booking.signed_at ? booking.signed_at.slice(0, 10) : "___________"}`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText(`Date: ${booking.signed_at ? booking.signed_at.slice(0, 10) : "___________"}`, { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });
  sy -= 16;
  page.drawText(`Contact Person: ${env.BUSINESS_OPERATOR || "Kenneth Lu"} (Operation Manager)`, { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });
  page.drawText(booking.signer_name ? `Signed by: ${booking.signer_name}` : "Unsigned", { x: colR, y: sy, size: 8.5, font, color: COLOR_TEXT });
  sy -= 12;
  page.drawText("Contact No.: 85099176", { x: colL, y: sy, size: 8.5, font, color: COLOR_TEXT });

  // Footer "Page X of Y" on every page — Y wasn't known until all pages were laid
  // out, so it's written in a final pass.
  const total = pages.length;
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(label, 9);
    p.drawText(label, { x: A4[0] / 2 - w / 2, y: 7, size: 9, font, color: rgb(1, 1, 1) });
  });

  return await doc.save();
}
