// Agreement Generator. Content is transcribed from Kenneth's real signed agreement
// PDFs (read 2026-07-12 from "Bojio Venue Agreement (Final) - Novan Management.pdf"
// and "Bojio Venue Agreement (Seminar).pdf"). Template picked by venue_space per
// Kenneth's confirmation: Whole Venue -> the general/Novan Management agreement,
// Main Hall Only -> the Seminar/Training Room agreement (matches which facilities
// are actually included in each case).
//
// One content array is the single source of truth, rendered two ways:
//   - agreementHtml(): shown on the /sign page for the client to read + sign
//   - buildAgreementPdf(): paginated PDF (pdf-lib), filed to Drive after signing
//
// NOTE: the Whole Venue PDF's printed cleaning fee ($100) is outdated — Kenneth
// confirmed $80 is the real current figure (2026-07-12); this template always uses
// the invoice's actual computed cleaning_fee, never a hardcoded number, so it can't drift.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const money = (n) => "$" + Number(n || 0).toFixed(2);

function wholeVenueContent(env, b) {
  return [
    { h: "EVENT SPACE RENTAL AGREEMENT" },
    { p: `This Agreement is made between ${env.BUSINESS_ENTITY || "Novan Management"} (UEN: ${env.BUSINESS_UEN || ""}), trading as ${env.BUSINESS_NAME || "BojioVenue"} (the "Venue"), address ${env.BUSINESS_ADDRESS || ""}, and the Client named below.` },
    { h: "1. Parties & Event Details" },
    { p: `Client's Name: ${b.client_name}` },
    { p: `NRIC / UEN: ${b.client_nric_uen || "___________"}` },
    { p: `Contact No.: ${b.client_phone || "___________"}    Email: ${b.client_email || "___________"}` },
    { p: `Event Date: ${b.booking_date}` },
    { p: `Event Time: From ${b.start_time || "___"} to ${b.end_time || "___"} (${b.hours}h). Complimentary setup time: 30 min provided in addition to rental hours (out of goodwill, subject to bookings ahead of yours).` },
    { p: `Event Purpose: ${b.notes || b.event_type}` },
    { p: `Rental Fee: ${money(b.rental_total)} (${money(b.hourly_rate)}/hr × ${b.hours}h)` },
    { p: `Security Deposit: ${money(b.deposit_amount)} (refundable, subject to Clause 8)` },
    { p: `Cleaning Fee: ${money(b.cleaning_fee)} (non-refundable)` },
    ...(Number(b.pet_fee) > 0 ? [{ p: `Pet Cleaning Fee: ${money(b.pet_fee)} (non-refundable)` }] : []),
    ...(Number(b.discount) > 0 ? [{ p: `Discount applied: -${money(b.discount)}` }] : []),
    { p: `Booking Invoice Total (rental + cleaning fee${Number(b.pet_fee) > 0 ? " + pet cleaning fee" : ""}${Number(b.discount) > 0 ? " - discount" : ""}): ${money(b.grand_total)}, payable to UEN: ${env.BUSINESS_UEN || ""} (${env.BUSINESS_ENTITY || "Novan Management"}). Security deposit is billed separately on the Deposit Invoice.` },
    { h: "2. Booking and Payment" },
    { p: "2.1 The booking is only confirmed upon receipt of full payment of the rental fee, payable to Novan Management. The security deposit and any applicable cleaning fees must be paid no later than thirty (30) days before the event date." },
    { p: "2.2 For bookings made less than thirty (30) days before the event date, full payment of rental fee, security deposit and cleaning fee must be made immediately." },
    { p: "2.3 The Venue reserves the right to cancel any unconfirmed booking without liability." },
    { h: "3. Overtime Charges" },
    { p: "3.1 The Client must vacate the Venue by the agreed time." },
    { p: "3.2 Any overrun exceeding fifteen (15) minutes will be charged as an additional full hour at the following rates: Weekdays $150/hr, Weekends $180/hr." },
    { h: "4. Cancellation and Postponement" },
    { p: "4.1 Cancellation more than six (6) weeks before the event: Full refund." },
    { p: "4.2 Cancellation three (3) to six (6) weeks before the event: 50% of the rental fee will be forfeited." },
    { p: "4.3 Cancellation less than three (3) weeks before the event: No refund." },
    { p: "4.4 Postponement more than four (4) weeks before the event: One (1) complimentary date change, subject to availability." },
    { p: "4.5 Postponement four (4) weeks or less before the event: $50 administrative fee applies." },
    { h: "5. Use of Venue" },
    { p: "5.1 The Venue shall be used solely for the stated purpose and during the agreed time." },
    { p: "5.2 The Client is responsible for ensuring that all attendees, vendors, and service providers comply with the Venue's House Rules (separate document)." },
    { p: "5.3 The Client shall not permit any unlawful activity or conduct likely to damage the Venue's reputation or property." },
    { p: "5.4 Smoking or vaping is strictly prohibited inside the Venue at all times, permitted only in designated outdoor smoking areas. Any breach (including indoor smoking, vaping, littering of cigarette butts in outside corridor areas) will result in deductions from the security deposit as stipulated in the Venue's House Rules. The Client shall ensure all attendees comply with Singapore laws and regulations, including those relating to smoking, alcohol consumption, and public safety. Any illegal activity is solely the Client's and attendees' responsibility; the Venue and Novan Management bear no liability and will refer matters to the relevant authorities where necessary." },
    { h: "6. Liability and Indemnity" },
    { p: "6.1 The Client shall be liable for any damage, loss, or excessive cleaning required as a result of the event." },
    { p: "6.2 If the total cost of repairs or cleaning exceeds the security deposit, the Client shall pay the difference within seven (7) days of receiving the invoice issued by Novan Management." },
    { p: "6.3 The Venue is not responsible for personal injury, loss, or damage to personal property occurring during the event." },
    { h: "7. Security Deposit" },
    { p: "7.1 The security deposit will be refunded within five (5) working days after the event, provided no damage, loss, or breach of this Agreement or House Rules has occurred." },
    { p: "7.2 Deductions may be made for: damage to property or equipment, excessive cleaning requirements, unreturned or lost keys." },
    { h: "8. Force Majeure" },
    { p: "The Venue shall not be held liable for failure to perform its obligations under this Agreement due to events beyond its reasonable control, including but not limited to government restrictions, natural disasters, or other emergencies. In such cases, the Venue may reschedule the event or provide a credit valid for twelve (12) months." },
    { h: "9. Governing Law" },
    { p: "This Agreement shall be governed by and construed in accordance with the laws of Singapore. The parties submit to the exclusive jurisdiction of the courts of Singapore." },
    { h: "10. Entire Agreement" },
    { p: "This Agreement, together with the Venue's House Rules (separate document), constitutes the entire agreement between the parties and supersedes all prior discussions or understandings." },
    { p: "Contact Person: Kenneth Lu (Operation Manager). Contact No.: 85099176." },
  ];
}

function mainHallContent(env, b) {
  return [
    { h: "SEMINAR / TRAINING ROOM RENTAL AGREEMENT" },
    { p: `This Agreement is made between ${env.BUSINESS_NAME || "BojioVenue"} (the "Venue"), address ${env.BUSINESS_ADDRESS || ""}, contact 85099176, and the Client named below.` },
    { h: "1. Parties & Booking Details" },
    { p: `Client's Name: ${b.client_name}` },
    { p: `NRIC: ${b.client_nric_uen || "___________"}` },
    { p: `Contact No.: ${b.client_phone || "___________"}    Email: ${b.client_email || "___________"}` },
    { p: "Room Booked: Main Hall Only" },
    { p: `Date: ${b.booking_date}` },
    { p: `Time: From ${b.start_time || "___"} to ${b.end_time || "___"} (${b.hours}h, includes setup and teardown). Complimentary setup time: 15 min provided in addition to rental hours (out of goodwill, subject to bookings ahead of yours).` },
    { p: `Purpose: ${b.notes || b.event_type}` },
    { p: `Rental Fee: ${money(b.rental_total)} (${money(b.hourly_rate)}/hr × ${b.hours}h)` },
    { p: `Security Deposit: ${money(b.deposit_amount)} (Refundable, see Clause 7)` },
    { p: `Cleaning Fee: ${money(b.cleaning_fee)} (Non-refundable)` },
    ...(Number(b.pet_fee) > 0 ? [{ p: `Pet Cleaning Fee: ${money(b.pet_fee)} (non-refundable)` }] : []),
    ...(Number(b.discount) > 0 ? [{ p: `Discount applied: -${money(b.discount)}` }] : []),
    { p: `Booking Invoice Total (rental + cleaning fee${Number(b.pet_fee) > 0 ? " + pet cleaning fee" : ""}${Number(b.discount) > 0 ? " - discount" : ""}): ${money(b.grand_total)}. Security deposit is billed separately on the Deposit Invoice.` },
    { h: "2. Facilities Included" },
    { p: "Rental includes use of: Tables & chairs, TV screen / Projector, Wi-Fi, Water dispenser, Toilet access. No use of entertainment facilities (KTV system, pool table, darts, arcade, etc.) is included." },
    { h: "3. Booking and Payment" },
    { p: "3.1 Booking is only confirmed upon receipt of full payment of the rental fee. The security deposit and any applicable cleaning fees must be paid no later than seven (7) days before the event date." },
    { p: "3.2 For bookings within seven (7) days of the event date, full payment must be made immediately." },
    { p: "3.3 Unconfirmed bookings may be cancelled by the Venue without liability." },
    { h: "4. Cancellation and Postponement" },
    { p: "More than 3 weeks' notice: 100% refund. 1–3 weeks' notice: 50% refund. Less than 1 week: No refund. One (1) complimentary postponement allowed if notified at least 14 days prior, subject to availability." },
    { h: "5. Use of Venue" },
    { p: "5.1 Venue shall be used solely for the stated purpose and during the agreed time." },
    { p: "5.2 No loud music and usage of entertainment facilities allowed." },
    { p: "5.3 Client shall not permit any unlawful activity or conduct likely to damage the Venue's reputation or property." },
    { p: "5.4 Client must ensure all attendees comply with BoJioVenue House Rules." },
    { h: "6. Security Deposit" },
    { p: "6.1 Client shall be liable for any damage, loss, or excessive cleaning required as a result of the event." },
    { p: "6.2 If the total cost of repairs or cleaning exceeds the security deposit, the Client shall pay the difference within seven (7) days of receiving the invoice." },
    { h: "7. Liability" },
    { p: "The Venue shall not be responsible for any injury, loss, or property damage occurring during use of the premises. The Client shall indemnify the Venue against any claims arising from their event or participants' actions." },
    { h: "8. Force Majeure" },
    { p: "If the event cannot proceed due to government restrictions or unforeseen circumstances, the Venue may reschedule or issue a credit valid for 12 months." },
    { h: "9. Governing Law" },
    { p: "This Agreement shall be governed by and construed in accordance with the laws of Singapore." },
    { h: "10. Entire Agreement" },
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
  return blocks
    .map((b) => (b.h ? `<h3>${esc(b.h)}</h3>` : `<p>${esc(b.p)}</p>`))
    .join("\n");
}

// ---------------------------------------------------------------------------
// PDF rendering — paginated (pdf-lib has no built-in text flow/wrapping).
// ---------------------------------------------------------------------------
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

export async function buildAgreementPdf(env, booking) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const A4 = [595.28, 841.89];
  const M = 50;
  const maxWidth = A4[0] - 2 * M;
  const dark = rgb(0.1, 0.1, 0.13);

  let page = doc.addPage(A4);
  let y = A4[1] - M;

  const ensureSpace = (h) => {
    if (y - h < M) {
      page = doc.addPage(A4);
      y = A4[1] - M;
    }
  };
  const heading = (text) => {
    ensureSpace(26);
    page.drawText(text, { x: M, y, size: 12, font: bold, color: dark });
    y -= 20;
  };
  const paragraph = (text) => {
    for (const line of wrapText(font, 9.5, text, maxWidth)) {
      ensureSpace(14);
      page.drawText(line, { x: M, y, size: 9.5, font, color: dark });
      y -= 13;
    }
    y -= 7;
  };

  page.drawText(env.BUSINESS_NAME || "BojioVenue", { x: M, y, size: 18, font: bold, color: dark });
  y -= 26;

  for (const block of agreementContent(env, booking)) {
    if (block.h) heading(block.h);
    else paragraph(block.p);
  }

  // Signature block. The signature image's bottom-left origin is `y`, and it can be
  // up to 55pt tall, so the gap below the heading must be >= 55 + a little padding
  // or the image's top edge overlaps the heading text above it.
  ensureSpace(130);
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.75, color: rgb(0.85, 0.85, 0.88) });
  y -= 18;
  page.drawText("SIGNED BY THE PARTIES", { x: M, y, size: 9, font: bold, color: dark });
  y -= 65;
  if (booking.signature_png) {
    try {
      const png = await doc.embedPng(booking.signature_png);
      const dims = png.scaleToFit(190, 55);
      page.drawImage(png, { x: M, y, width: dims.width, height: dims.height });
    } catch (e) {
      console.log("[agreement] signature embed failed: " + e);
    }
  }
  page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + 210, y: y - 4 }, thickness: 0.75, color: rgb(0.85, 0.85, 0.88) });
  page.drawText(booking.signer_name || booking.client_name || "", { x: M, y: y - 16, size: 9, font });
  page.drawText(booking.signed_at ? `Signed: ${booking.signed_at}` : "Unsigned", { x: M, y: y - 28, size: 8, font, color: rgb(0.45, 0.45, 0.5) });

  return await doc.save();
}
