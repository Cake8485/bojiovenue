// PayNow SGQR generator (EMVCo Merchant-Presented Mode, Singapore's PayNow profile).
//
// Hand-rolled against EMVCo's official "EMV QR Code Specification for Payment
// Systems, Merchant-Presented Mode v1.1" rather than an existing PayNow-specific
// npm package — the few that exist (paynowqr, @chewhx/paynowqr, @jeremyling/sg-paynow-qr)
// are single-maintainer, unmaintained for years, and don't render an actual QR image.
// The payload format itself is small and fully specified (~10 TLV fields + a CRC), so
// re-implementing and verifying it directly is more trustworthy for money-handling
// code than depending on a low-traffic package. The CRC16 implementation below was
// verified against a real decoded PayNow payload during development (payload's own
// trailing CRC matched the freshly-computed one exactly).
//
// Rendering uses `qrcode-generator` (kazuhikoarase, MIT, zero deps) — the far more
// popular `qrcode` package fails inside Cloudflare Workers (its bundler-dependent
// `browser` field isn't honored by Wrangler's esbuild, so it resolves to a Node path
// needing `canvas`/`pngjs`). `qrcode-generator` has no such dependency and works
// identically in the Worker (server-side) and in a browser <script> if ever needed.
//
// Two renderings are exposed: an SVG string (for the /sign page) and a raw dark/light
// module matrix (so pdf-lib can draw the QR as plain vector rectangles — no PNG/canvas
// involved at all, which keeps PDF generation dependency-free).

import qrcode from "qrcode-generator";

const GUID = "SG.PAYNOW";

function tlv(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, "0") + v;
}

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no input/output reflection, no XorOut.
// Per spec: computed over the full payload up to and including the "6304" tag+length
// of the CRC field itself, excluding the CRC's own 4-hex-digit value.
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// uen: BojioVenue's UEN (proxy type "2"). amount: SGD number. reference: shown as
// the bill number in the payer's banking app — kept short (invoice no + client name)
// so Kenneth can identify the payment without opening the invoice.
export function buildPayNowPayload({ uen, amount, reference, merchantName }) {
  const merchantInfo =
    tlv("00", GUID) +
    tlv("01", "2") + // proxy type: UEN (vs "0" for mobile number)
    tlv("02", uen) +
    tlv("03", "0"); // amount fixed — not editable by the payer

  const additionalData = tlv("01", String(reference || "").slice(0, 60)); // bill number

  let payload =
    tlv("00", "01") + // payload format indicator
    tlv("01", "12") + // dynamic QR — one specific amount/reference, not reusable
    tlv("26", merchantInfo) +
    tlv("52", "0000") + // merchant category code: unclassified
    tlv("53", "702") + // transaction currency: SGD (ISO 4217)
    tlv("54", Number(amount || 0).toFixed(2)) +
    tlv("58", "SG") +
    tlv("59", String(merchantName || "Novan Management").slice(0, 25)) +
    tlv("60", "Singapore") +
    tlv("62", additionalData);

  payload += "6304"; // CRC tag + length; value appended next
  payload += crc16(payload);
  return payload;
}

function qrFor(payload) {
  const qr = qrcode(0, "M"); // type 0 = auto-size, M = medium error correction
  qr.addData(payload);
  qr.make();
  return qr;
}

// Inline SVG string for the /sign page — self-contained, no external image request.
export function payNowQrSvg(payload) {
  return qrFor(payload).createSvgTag({ margin: 1, scalable: true });
}

// Raw module matrix so pdf-lib can draw the QR as plain filled rectangles (no PNG
// encoding/embedding needed for a document generated inside the Worker).
export function payNowQrMatrix(payload) {
  const qr = qrFor(payload);
  const count = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < count; r++) {
    const row = [];
    for (let c = 0; c < count; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { count, modules };
}

// Convenience: builds the payload straight from an invoice + what it's for.
export function invoicePayNowPayload(env, inv, amount, kind) {
  return buildPayNowPayload({
    uen: env.BUSINESS_UEN,
    amount,
    reference: `${inv.invoice_no} ${inv.client_name} ${kind}`,
    merchantName: env.BUSINESS_ENTITY,
  });
}
