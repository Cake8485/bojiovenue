// Shared branded-PDF rendering primitives for the "Money Document" identity
// (Addendum 6, 2026-08-24) — Rental Invoice (INV), Rental Receipt (RRC), and the
// Security Deposit doc (SD). Deliberately SEPARATE from branding.js's sky-blue/
// yellow-card identity, which stays exactly as-is for the Agreement + Deduction
// Addendum (Kenneth's explicit split: "TWO identities").
//
// Colors/layout matched against two real filed documents Kenneth pointed at
// (RRC-2026036.pdf, SD-00023.pdf — Zoho-generated) rather than invented: lavender
// top band, purple title, purple table header bar, cream logo box, mascot
// watermark, Open Sans body text. Exact pixel positions weren't extractable from
// those PDFs (only text content), so this is a faithful-by-description rebuild —
// expect Kenneth to want minor spacing tweaks once he sees real output.

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { openSansFont, openSansBoldFont, logoPng, mascotPng } from "./assets.js";
import { wrapText, roundedRectPath } from "./branding.js";

export const MONEY_BAND = rgb(0.6902, 0.5804, 0.8118); // #B094CF lavender top/footer band
export const MONEY_TITLE = rgb(0.5216, 0.3490, 0.7137); // #8559B6 purple doc title
export const MONEY_HEADER_BAR = rgb(0.6667, 0.5137, 0.8745); // #AA83DF purple table header
export const MONEY_TEXT = rgb(0.2, 0.2, 0.2); // #333333 body
export const MONEY_GREY = rgb(0.46, 0.46, 0.46); // secondary labels
export const MONEY_CREAM = rgb(0.9961, 0.9647, 0.9020); // #FEF6E6 logo box
export const MONEY_RED = rgb(0.75, 0.16, 0.16); // "Payment Made (-)"
export const MONEY_RULE = rgb(0.85, 0.85, 0.87);
export const MONEY_BADGE_BG = rgb(0.94, 0.91, 0.97);
export const MONEY_WHITE = rgb(1, 1, 1);

export const MA4 = [595.28, 841.89];
export const MM = 42; // page margin
export const BAND_H = 34;
export const FOOTER_H = 30;

const money = (n) => "$" + Number(n || 0).toFixed(2);

// ---------------------------------------------------------------------------
// Doc setup — fonts + logo + mascot, shared by every money document.
// ---------------------------------------------------------------------------
export async function startMoneyDoc() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(openSansFont);
  const bold = await doc.embedFont(openSansBoldFont);

  let logoImg = null;
  try {
    logoImg = await doc.embedPng(new Uint8Array(logoPng));
  } catch (e) {
    console.log("[brandingMoney] logo embed failed: " + e);
  }
  let mascotImg = null;
  try {
    mascotImg = await doc.embedPng(new Uint8Array(mascotPng));
  } catch (e) {
    console.log("[brandingMoney] mascot embed failed: " + e);
  }
  return { doc, font, bold, logoImg, mascotImg };
}

// ---------------------------------------------------------------------------
// Page shell — call once per new page. Draws the lavender top band; the bottom
// treatment differs by doc type (drawReceiptFooter vs drawPlainFooter, below),
// drawn as a final pass once total page count is known (see finishMoneyDoc).
// ---------------------------------------------------------------------------
function newMoneyPage(doc) {
  const page = doc.addPage(MA4);
  page.drawRectangle({ x: 0, y: MA4[1] - BAND_H, width: MA4[0], height: BAND_H, color: MONEY_BAND });
  return page;
}

// ---------------------------------------------------------------------------
// Header block — logo (cream box, top-left) + business info, doc title + number
// (top-right) with a small "Balance Due" preview badge, then a left info column
// (caller-supplied label/value pairs — e.g. Invoice Date/Event Date) and a right
// "Bill To" column with the client's name + phone. One shared layout for all three
// money-document types (INV/RRC/SD) rather than replicating each sample's own
// slightly different arrangement — see file header comment.
// ---------------------------------------------------------------------------
export function drawMoneyHeader(ctx, env, { docTitle, docNumberLabel, docNumber, balanceDue, leftInfo, client }) {
  const { page, font, bold, logoImg } = ctx;
  const T = (s, x, y, o = {}) => page.drawText(String(s ?? ""), { x, y, size: o.size ?? 9.5, font: o.f ?? font, color: o.color ?? MONEY_TEXT });
  const R = (s, xRight, y, o = {}) => {
    const f = o.f ?? font, size = o.size ?? 9.5;
    const w = f.widthOfTextAtSize(String(s ?? ""), size);
    page.drawText(String(s ?? ""), { x: xRight - w, y, size, font: f, color: o.color ?? MONEY_TEXT });
  };

  let y = MA4[1] - BAND_H - 16;

  // Logo, cream box top-left.
  const boxW = 96, boxH = 56;
  const boxX = MM, boxY = y - boxH + 10;
  page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, color: MONEY_CREAM });
  if (logoImg) {
    const dims = logoImg.scaleToFit(boxW - 14, boxH - 14);
    page.drawImage(logoImg, { x: boxX + (boxW - dims.width) / 2, y: boxY + (boxH - dims.height) / 2, width: dims.width, height: dims.height });
  }
  T(env.BUSINESS_NAME || "BojioVenue", boxX, boxY - 13, { size: 10, f: bold, color: MONEY_TITLE });
  T(env.BUSINESS_ADDRESS_LINE1 || "", boxX, boxY - 25, { size: 8, color: MONEY_GREY });
  T(env.BUSINESS_ADDRESS_LINE2 || "", boxX, boxY - 35, { size: 8, color: MONEY_GREY });
  T(`${env.BUSINESS_ADDRESS_LINE3 || ""}`, boxX, boxY - 45, { size: 8, color: MONEY_GREY });
  T(`${env.BUSINESS_PHONE || ""}  ·  ${env.BUSINESS_EMAIL || ""}`, boxX, boxY - 57, { size: 8, color: MONEY_GREY });

  // Title + doc number, top-right.
  R(docTitle, MA4[0] - MM, y - 8, { size: 22, f: bold, color: MONEY_TITLE });
  R(`${docNumberLabel || "No."}# ${docNumber}`, MA4[0] - MM, y - 30, { size: 10.5, f: bold, color: MONEY_TEXT });

  // Balance Due preview badge.
  if (balanceDue !== undefined && balanceDue !== null) {
    const badgeW = 150, badgeH = 30, badgeX = MA4[0] - MM - badgeW, badgeY = y - 66;
    page.drawSvgPath(roundedRectPath(badgeW, badgeH, 6), { x: badgeX, y: badgeY + badgeH, color: MONEY_BADGE_BG });
    T("Balance Due", badgeX + 10, badgeY + 18, { size: 8, color: MONEY_GREY });
    R(`SGD ${Number(balanceDue).toFixed(2)}`, badgeX + badgeW - 10, badgeY + 8, { size: 11, f: bold, color: MONEY_TITLE });
  }

  y = boxY - 72;

  // Left info column (caller-supplied) + right "Bill To" column.
  const colR = MA4[0] / 2 + 20;
  let ly = y, ry = y;
  for (const { label, value } of leftInfo) {
    T(label, MM, ly, { size: 8.5, color: MONEY_GREY });
    R(value, colR - 30, ly, { size: 8.5 });
    ly -= 13;
  }
  T(client.header || "Bill To", colR, ry, { size: 8.5, f: bold, color: MONEY_GREY });
  ry -= 13;
  T(client.name || "", colR, ry, { size: 10, f: bold });
  ry -= 13;
  if (client.phone) { T(client.phone, colR, ry, { size: 8.5, color: MONEY_GREY }); ry -= 13; }

  return Math.min(ly, ry) - 14;
}

// ---------------------------------------------------------------------------
// Line items table — purple header bar + white column labels, then rows.
// columns: [{ key, label, width, align: 'left'|'right' }] — width in points,
// summing to content width. rows: [{ cells: {key: text}, sublines: [text,...],
// bold: true }] — sublines render as smaller grey lines under the FIRST column
// only (matches the real samples' "Include: ..." / promo-note sub-lines under the
// item description).
// ---------------------------------------------------------------------------
export function drawLineItemsTable(ctx, startY, { columns, rows }) {
  const { font, bold } = ctx;
  let page = ctx.page; // mutable — a mid-table page break (see below) must affect every draw call after it, not just ctx
  let y = startY;
  const contentW = MA4[0] - 2 * MM;
  const barH = 20;

  function colX(i) {
    let x = MM;
    for (let j = 0; j < i; j++) x += columns[j].width;
    return x;
  }

  function drawHeaderBar() {
    page.drawRectangle({ x: MM, y: y - barH, width: contentW, height: barH, color: MONEY_HEADER_BAR });
    columns.forEach((c, i) => {
      const x = colX(i);
      if (c.align === "right") {
        const w = bold.widthOfTextAtSize(c.label, 8.5);
        page.drawText(c.label, { x: x + c.width - 8 - w, y: y - barH + 6.5, size: 8.5, font: bold, color: MONEY_WHITE });
      } else {
        page.drawText(c.label, { x: x + 6, y: y - barH + 6.5, size: 8.5, font: bold, color: MONEY_WHITE });
      }
    });
    y -= barH;
  }
  drawHeaderBar();

  for (const row of rows) {
    const lineH = 15;
    const rowH = lineH + row.sublines.length * 11 + 6;
    if (y - rowH < 130) {
      page.drawLine({ start: { x: MM, y }, end: { x: MM + contentW, y }, thickness: 0.5, color: MONEY_RULE });
      page = newMoneyPage(ctx.doc);
      ctx.page = page; // callers after this one (summary/notes/terms) must see the new page too
      y = MA4[1] - BAND_H - 30;
      // NOTE: header bar intentionally not re-drawn on continuation pages — money
      // documents from this system are short enough in practice that this path is
      // a safety net, not a designed multi-page layout.
    }
    const f = row.bold ? bold : font;
    columns.forEach((c, i) => {
      const x = colX(i);
      const val = row.cells[c.key] ?? "";
      if (c.align === "right") {
        const w = f.widthOfTextAtSize(String(val), 9.5);
        page.drawText(String(val), { x: x + c.width - 8 - w, y: y - 12, size: 9.5, font: f, color: MONEY_TEXT });
      } else {
        page.drawText(String(val), { x: x + 6, y: y - 12, size: 9.5, font: f, color: MONEY_TEXT });
      }
    });
    let sy = y - 12 - 12;
    for (const sub of row.sublines) {
      page.drawText(sub, { x: colX(0) + 6, y: sy, size: 8, font, color: MONEY_GREY });
      sy -= 11;
    }
    y -= rowH;
    page.drawLine({ start: { x: MM, y: y + 3 }, end: { x: MM + contentW, y: y + 3 }, thickness: 0.5, color: MONEY_RULE });
  }

  return y - 6;
}

// ---------------------------------------------------------------------------
// Summary block — Sub Total / Total / Payment Made (red, "(-) amount") / Balance
// Due, right-aligned under the table, matching both real samples exactly.
// ---------------------------------------------------------------------------
export function drawSummaryBlock(ctx, startY, { subTotal, total, paymentMade, balanceDue }) {
  const { page, font, bold } = ctx;
  let y = startY;
  const xRight = MA4[0] - MM;
  const xLabel = MA4[0] - MM - 190;

  const line = (label, value, o = {}) => {
    page.drawText(label, { x: xLabel, y, size: o.size ?? 9.5, font: o.f ?? font, color: o.color ?? MONEY_TEXT });
    const f = o.vf ?? o.f ?? font, size = o.size ?? 9.5;
    const w = f.widthOfTextAtSize(value, size);
    page.drawText(value, { x: xRight - w, y, size, font: f, color: o.vcolor ?? o.color ?? MONEY_TEXT });
    y -= o.gap ?? 15;
  };

  line("Sub Total", money(subTotal));
  line("Total", money(total), { f: bold, vf: bold, size: 10.5 });
  if (Number(paymentMade) > 0) line("Payment Made", `(-) ${money(paymentMade)}`, { color: MONEY_RED, vcolor: MONEY_RED });
  y -= 3;
  page.drawRectangle({ x: xLabel - 8, y: y - 4, width: xRight - xLabel + 8, height: 20, color: MONEY_BADGE_BG });
  line("Balance Due", `SGD${Number(balanceDue).toFixed(2)}`, { f: bold, vf: bold, size: 11, color: MONEY_TITLE, vcolor: MONEY_TITLE });

  return y - 12;
}

// ---------------------------------------------------------------------------
// Notes block — Payment Mode/Bank/Reference, shown only once a relevant payment
// exists (see pdf.js/receipts.js callers).
// ---------------------------------------------------------------------------
export function drawNotesBlock(ctx, startY, lines) {
  if (!lines || !lines.length) return startY;
  const { page, font, bold } = ctx;
  let y = startY;
  page.drawText("Notes", { x: MM, y, size: 8.5, font: bold, color: MONEY_GREY });
  y -= 14;
  for (const l of lines) {
    page.drawText(l, { x: MM, y, size: 9, font, color: MONEY_TEXT });
    y -= 13;
  }
  return y - 10;
}

// ---------------------------------------------------------------------------
// Terms & Conditions — bullet list, doc-type-specific text supplied by the caller
// (see pdf.js/receipts.js for the exact wording per document, copied from the real
// samples).
// ---------------------------------------------------------------------------
export function drawTermsBlock(ctx, startY, bullets) {
  const { page, font, bold } = ctx;
  let y = startY;
  const contentW = MA4[0] - 2 * MM;
  page.drawText("Terms & Conditions", { x: MM, y, size: 8.5, font: bold, color: MONEY_GREY });
  y -= 13;
  for (const b of bullets) {
    const lines = wrapText(font, 8, "- " + b, contentW);
    for (const line of lines) {
      page.drawText(line, { x: MM, y, size: 8, font, color: MONEY_GREY });
      y -= 11;
    }
  }
  return y - 6;
}

// ---------------------------------------------------------------------------
// Mascot watermark — bottom-right, faded. Drawn on every page (real samples show
// it on the single page they have; a safety-net second page gets one too).
// ---------------------------------------------------------------------------
export function drawMascotWatermark(ctx, page) {
  if (!ctx.mascotImg) return;
  const dims = ctx.mascotImg.scaleToFit(90, 90);
  page.drawImage(ctx.mascotImg, {
    x: MA4[0] - MM - dims.width,
    y: FOOTER_H + 14,
    width: dims.width,
    height: dims.height,
    opacity: 0.22,
  });
}

// ---------------------------------------------------------------------------
// Footer — receipts (RRC) get the lavender band + tagline; invoices/SD get a
// plain rule + page number, matching the observed difference between the two real
// samples exactly (SD-00023.pdf has no tagline band at all).
// ---------------------------------------------------------------------------
export function drawReceiptFooter(page, font) {
  page.drawRectangle({ x: 0, y: 0, width: MA4[0], height: FOOTER_H, color: MONEY_BAND });
  // No emoji here: Open Sans (a plain text TTF) has no emoji glyph coverage, and
  // pdf-lib/fontkit silently mis-renders codepoints outside the Basic Multilingual
  // Plane through a custom-embedded font (verified against a real generated PDF —
  // a party-popper emoji here came out as a sparkle instead, twice, not even the
  // right glyph) rather than throwing, so a rendering bug would go unnoticed.
  const label = "Thanks for jio-ing with us — your event, our vibes!";
  const w = font.widthOfTextAtSize(label, 9);
  page.drawText(label, { x: MA4[0] / 2 - w / 2, y: 11, size: 9, font, color: MONEY_WHITE });
}

export function drawPlainFooter(page, font, pageNum) {
  page.drawLine({ start: { x: MM, y: FOOTER_H }, end: { x: MA4[0] - MM, y: FOOTER_H }, thickness: 0.5, color: MONEY_RULE });
  const label = String(pageNum);
  const w = font.widthOfTextAtSize(label, 9);
  page.drawText(label, { x: MA4[0] - MM - w, y: FOOTER_H - 14, size: 9, font, color: MONEY_GREY });
}

// ---------------------------------------------------------------------------
// Finishing pass — draws the mascot watermark + the appropriate footer on every
// page once all content (and therefore the true page count) is known.
// ---------------------------------------------------------------------------
export function finishMoneyDoc(ctx, { footer }) {
  const pages = ctx.doc.getPages();
  pages.forEach((p, i) => {
    drawMascotWatermark(ctx, p);
    if (footer === "receipt") drawReceiptFooter(p, ctx.font);
    else drawPlainFooter(p, ctx.font, i + 1);
  });
}

export { newMoneyPage };
