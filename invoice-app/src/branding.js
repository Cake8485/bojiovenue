// Shared branded-PDF rendering primitives — the sky-blue/yellow-card/purple-text
// design used by the Agreement (agreement.js) and, since Addendum 3, the payment
// receipts (receipts.js) too. Extracted so both document types stay visually
// identical without duplicating the page-shell/card-drawing logic.
//
// pdf-lib has no built-in text flow, rounded-rect primitive, or page-count-aware
// footer — all hand-rolled below exactly as originally built for the Agreement.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { barlowBoldFont, logoPng } from "./assets.js";
import { payNowQrMatrix } from "./paynow.js";

export const COLOR_BG = rgb(0.576, 0.776, 0.851); // #93C6D9 sky blue
export const COLOR_CARD = rgb(1, 0.871, 0.345); // #FFDE58 yellow
export const COLOR_FRAME = rgb(0.247, 0.126, 0.361); // #3F205C deep purple
export const COLOR_TEXT = rgb(0.184, 0.043, 0.365); // #2F0B5D purple body text
export const A4 = [595.28, 841.89];
export const M = 42; // page margin outside the frame
export const BAR_H = 22; // top/bottom purple bar height
export const CARD_PAD = 14;
export const CARD_GAP = 12;

export function wrapText(font, size, text, maxWidth) {
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
export function roundedRectPath(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

// Sets up a fresh branded doc + fonts + logo. `logoImageBytes` lets a caller pass a
// different image; defaults to the bundled BojioVenue logo.
export async function startBrandedDoc(logoImageBytes) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titleFont = await doc.embedFont(barlowBoldFont); // real Barlow Bold, bundled

  const logoBytes = logoImageBytes || logoPng;
  let logoImg = null;
  if (logoBytes) {
    const bytes = new Uint8Array(logoBytes);
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = PNG_SIG.every((byte, i) => bytes[i] === byte);
    try {
      logoImg = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch (e) {
      console.log("[branding] logo embed failed: " + e);
    }
  }
  return { doc, font, bold, titleFont, logoImg };
}

// Draws `blocks` (content array: {newCard, h, p, bold}) as yellow rounded cards on
// as many pages as needed, each page starting with the sky-blue background, purple
// top/bottom bars, logo, and Barlow Bold title. Returns everything a caller needs to
// either finish immediately or append more content (e.g. the Agreement's signature
// block) on the same flow before footers are drawn.
export function drawBrandedCards({ doc, font, bold, titleFont, logoImg, title, blocks }) {
  const contentW = A4[0] - 2 * M;
  const maxTextW = contentW - 2 * CARD_PAD;

  const measured = blocks.map((b) => {
    if (b.h) return { ...b, lines: [b.h], size: 10.5, isHeading: true };
    const lines = wrapText(font, 9.5, b.p, maxTextW);
    return { ...b, lines, size: 9.5, isHeading: false };
  });

  const cards = [];
  for (const blk of measured) {
    if (blk.newCard || cards.length === 0) cards.push([]);
    cards[cards.length - 1].push(blk);
  }

  let page;
  let y;
  const pages = [];

  function newPage() {
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
    return { page, y };
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

  return { pages, page, y, contentW, newPage };
}

// Draws a PayNow QR (see paynow.js) as plain filled rectangles, one per dark
// module — no PNG/canvas involved, so it drops straight into any pdf-lib page
// alongside everything else this file draws. `x`/`yTop` is the QR's top-left
// corner in PDF coordinates; `sizePt` is the full square's side length.
export function drawPayNowQr(page, payload, x, yTop, sizePt) {
  const { count, modules } = payNowQrMatrix(payload);
  const cell = sizePt / count;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!modules[r][c]) continue;
      page.drawRectangle({ x: x + c * cell, y: yTop - sizePt + (count - 1 - r) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
    }
  }
}

// Footer "Page X of Y" on every page — Y isn't known until all pages are laid out,
// so this is always a final pass after all content (including any trailing
// signature block) has been drawn.
export function drawPageFooters(pages, font) {
  const total = pages.length;
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(label, 9);
    p.drawText(label, { x: A4[0] / 2 - w / 2, y: 7, size: 9, font, color: rgb(1, 1, 1) });
  });
}
