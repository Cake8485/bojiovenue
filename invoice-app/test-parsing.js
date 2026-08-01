// Regression tests for src/parsing.js — plain Node `assert`, no test framework
// dependency (matches this project's $0/minimal-deps philosophy). Run with:
//   node test-parsing.js
//
// Added 2026-08-02 after a real dry-run bug report: several of Kenneth's actual
// WhatsApp-forward messages ("21Aug26", "8hours", "$1200/-") weren't parsing
// correctly, and the failure was silent (see worker.js's telegramWebhook for the
// separate error-handling fix). These are his exact reported inputs, plus the
// existing formats that must keep working.

import assert from "node:assert/strict";
import {
  parseTelegramTemplate, parseFlexibleDate, parseLooseNumber, parseFlexibleTime, extractDollarNear,
  detectWaTemplateType, parseWaEventDetails, parseWaQuote, parseWaParticulars, waAccumulationToFields,
} from "./src/parsing.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// parseFlexibleDate
// ---------------------------------------------------------------------------
test("parseFlexibleDate: strict YYYY-MM-DD (§5a)", () => {
  assert.equal(parseFlexibleDate("2026-08-15"), "2026-08-15");
});
test("parseFlexibleDate: 'D Mon YYYY' with spaces", () => {
  assert.equal(parseFlexibleDate("15 Aug 2026"), "2026-08-15");
});
test("parseFlexibleDate: real dry-run input '21Aug26' — no spaces, 2-digit year", () => {
  assert.equal(parseFlexibleDate("21Aug26"), "2026-08-21");
});
test("parseFlexibleDate: no spaces, 4-digit year", () => {
  assert.equal(parseFlexibleDate("21Aug2026"), "2026-08-21");
});
test("parseFlexibleDate: single-digit day, no spaces", () => {
  assert.equal(parseFlexibleDate("5Sep26"), "2026-09-05");
});
test("parseFlexibleDate: unparseable input returns null, not a guess", () => {
  assert.equal(parseFlexibleDate("next friday"), null);
  assert.equal(parseFlexibleDate(""), null);
  assert.equal(parseFlexibleDate(undefined), null);
});
test("parseFlexibleDate: genuinely ambiguous numeric format stays unparsed", () => {
  assert.equal(parseFlexibleDate("08/09"), null);
});

// ---------------------------------------------------------------------------
// parseLooseNumber
// ---------------------------------------------------------------------------
test("parseLooseNumber: real dry-run input '8hours' — no space before unit", () => {
  assert.equal(parseLooseNumber("8hours"), 8);
});
test("parseLooseNumber: '8 hours' with space", () => {
  assert.equal(parseLooseNumber("8 hours"), 8);
});
test("parseLooseNumber: bare number", () => {
  assert.equal(parseLooseNumber("8"), 8);
});
test("parseLooseNumber: real dry-run input '$1200/-'", () => {
  assert.equal(parseLooseNumber("$1200/-"), 1200);
});
test("parseLooseNumber: plain dollar amount", () => {
  assert.equal(parseLooseNumber("$150"), 150);
});
test("parseLooseNumber: thousands comma", () => {
  assert.equal(parseLooseNumber("$1,200/-"), 1200);
});
test("parseLooseNumber: decimal amount", () => {
  assert.equal(parseLooseNumber("$61.50"), 61.5);
});
test("parseLooseNumber: hrs/hr/h unit variants", () => {
  assert.equal(parseLooseNumber("8hrs"), 8);
  assert.equal(parseLooseNumber("8hr"), 8);
  assert.equal(parseLooseNumber("8h"), 8);
});
test("parseLooseNumber: unparseable returns null, never NaN or a silent 0", () => {
  assert.equal(parseLooseNumber("TBC"), null);
  assert.equal(parseLooseNumber(""), null);
  assert.equal(parseLooseNumber(null), null);
  assert.notEqual(parseLooseNumber("TBC"), 0); // must not silently look like "genuinely zero"
});

// ---------------------------------------------------------------------------
// parseFlexibleTime
// ---------------------------------------------------------------------------
test("parseFlexibleTime: real WhatsApp-template value '11.00am' (period separator, am/pm)", () => {
  assert.equal(parseFlexibleTime("11.00am"), "11:00");
});
test("parseFlexibleTime: 24h 'HH:MM' unchanged (existing strict-template format)", () => {
  assert.equal(parseFlexibleTime("18:00"), "18:00");
  assert.equal(parseFlexibleTime("14:00"), "14:00");
});
test("parseFlexibleTime: colon separator with am/pm", () => {
  assert.equal(parseFlexibleTime("6:30pm"), "18:30");
});
test("parseFlexibleTime: bare hour with am/pm, no minutes", () => {
  assert.equal(parseFlexibleTime("6pm"), "18:00");
  assert.equal(parseFlexibleTime("9am"), "09:00");
});
test("parseFlexibleTime: 12am/12pm edge cases (midnight/noon)", () => {
  assert.equal(parseFlexibleTime("12am"), "00:00");
  assert.equal(parseFlexibleTime("12pm"), "12:00");
});
test("parseFlexibleTime: unparseable input returns null, not a guess", () => {
  assert.equal(parseFlexibleTime("evening"), null);
  assert.equal(parseFlexibleTime(""), null);
  assert.equal(parseFlexibleTime("25:00"), null);
});

// ---------------------------------------------------------------------------
// extractDollarNear — real quote template's "1) $80 Cleaning fee" / "2) $500
// deposit (...)" shape: amount BEFORE the label, numbered list, no colon at
// all, so parseTelegramTemplate's label:value matching never sees these lines.
// ---------------------------------------------------------------------------
test("extractDollarNear: amount-before-label, real default-quote wording ('1) $80 Cleaning fee')", () => {
  assert.equal(extractDollarNear("1) $80 Cleaning fee", "cleaning"), "80");
});
test("extractDollarNear: amount-before-label with a trailing parenthetical ('2) $500 deposit (Refundable...)')", () => {
  assert.equal(extractDollarNear("2) $500 deposit (Refundable within 5 working days after the event)", "deposit"), "500");
});
test("extractDollarNear: real promo-quote wording ('1) $61 Cleaning fee')", () => {
  assert.equal(extractDollarNear("1) $61 Cleaning fee", "cleaning"), "61");
});
test("extractDollarNear: falls back to label-before-amount phrasing ('Cleaning Fee: $80/-')", () => {
  assert.equal(extractDollarNear("Cleaning Fee: $80/-", "cleaning"), "80");
});
test("extractDollarNear: no match returns null", () => {
  assert.equal(extractDollarNear("nothing relevant here", "cleaning"), null);
});

// ---------------------------------------------------------------------------
// parseTelegramTemplate — label punctuation
// ---------------------------------------------------------------------------
test("parseTelegramTemplate: label with a period ('No. Of Hours:')", () => {
  const f = parseTelegramTemplate("No. Of Hours: 8");
  assert.equal(f["no. of hours"], "8");
});
test("parseTelegramTemplate: label with parens and slash ('Name of Host (as in NRIC)/ Company:')", () => {
  const f = parseTelegramTemplate("Name of Host (as in NRIC)/ Company: Jane Tan");
  assert.equal(f["name of host (as in nric)/ company"], "Jane Tan");
});
test("parseTelegramTemplate: simple strict-template labels still work", () => {
  const f = parseTelegramTemplate("Name: Jane Tan\nDate of Event: 2026-08-15");
  assert.equal(f["name"], "Jane Tan");
  assert.equal(f["date of event"], "2026-08-15");
});
test("parseTelegramTemplate: label containing a digit ('Last 4 Digit NRIC / UEN:') — real bug, found by this suite", () => {
  const f = parseTelegramTemplate("Last 4 Digit NRIC / UEN: 161E");
  assert.equal(f["last 4 digit nric / uen"], "161E");
});
test("parseTelegramTemplate: a bare digit-first line (e.g. a lone time) is never misread as a label", () => {
  const f = parseTelegramTemplate("18:00");
  assert.deepEqual(f, {});
});
test("parseTelegramTemplate: emoji-prefixed label, real template wording ('📅 Date Of Event:  21Aug26') — real bug, found against Kenneth's actual message", () => {
  const f = parseTelegramTemplate("📅 Date Of Event:  21Aug26");
  assert.equal(f["date of event"], "21Aug26");
});
test("parseTelegramTemplate: multiple different emoji prefixes in one message", () => {
  const f = parseTelegramTemplate("🆔 Last 4 Digit NRIC / UEN:  661A\n📱 Contact Number:  93219316");
  assert.equal(f["last 4 digit nric / uen"], "661A");
  assert.equal(f["contact number"], "93219316");
});
test("parseTelegramTemplate: a line with no letters at all (pure emoji/punctuation) yields no field, doesn't throw", () => {
  const f = parseTelegramTemplate("👍👍👍");
  assert.deepEqual(f, {});
});

// ---------------------------------------------------------------------------
// detectWaTemplateType — must not collide with the strict template (2026-08-02
// routing bug: a complete strict-template message was being misread as a lone
// WA event-details fragment because both use "Date of Event:")
// ---------------------------------------------------------------------------
test("detectWaTemplateType: event details", () => {
  assert.equal(detectWaTemplateType("Date Of Event: 21Aug26\nNo. Of Hours: 8"), "event_details");
});
test("detectWaTemplateType: quote", () => {
  assert.equal(detectWaTemplateType("Usual rate: $150/hr\nFinal Price: $1200/-"), "quote");
});
test("detectWaTemplateType: particulars", () => {
  assert.equal(detectWaTemplateType("Name of Host (as in NRIC)/ Company: Jane"), "particulars");
});
test("detectWaTemplateType: no match for unrelated text", () => {
  assert.equal(detectWaTemplateType("hello there"), null);
});
// NOTE: worker.js's telegramWebhook checks "is this a complete strict-template
// message" (has both `name` and `date of event`) BEFORE ever calling
// detectWaTemplateType, specifically because a complete §5a message also
// contains "Date of Event:" and would otherwise match here too. That
// disambiguation lives in worker.js, not here — this file only covers what
// detectWaTemplateType itself does in isolation.

// ---------------------------------------------------------------------------
// Full parse of Kenneth's real dry-run message shapes
// ---------------------------------------------------------------------------
test("parseWaEventDetails: real dry-run message (21Aug26, 8hours)", () => {
  const parsed = parseWaEventDetails("Date Of Event: 21Aug26\nNo. Of Hours: 8hours\nStart Time of Event: 18:00\nType Of Event: Social");
  assert.equal(parsed.date_of_event, "21Aug26");
  assert.equal(parsed.hours, "8hours");
  assert.equal(parsed.start_time, "18:00");
  assert.equal(parsed.event_type, "Social");
});
test("parseWaQuote: real dry-run message ($1200/- style values)", () => {
  const parsed = parseWaQuote("Usual rate: $180/hr\nPackage 8 hours: $150/hr\nTotal: $1200/-\nFinal Price: $1200/-\nCleaning Fee: $80/-\nDeposit: $500/-");
  assert.equal(parsed.package_hours, "8");
  assert.equal(parsed.package_rate, "150");
  assert.equal(parsed.cleaning_fee, "$80/-");
  assert.equal(parsed.deposit_amount, "$500/-");
});
test("parseWaParticulars: real template shape", () => {
  const parsed = parseWaParticulars("Name of Host (as in NRIC)/ Company: Jane Tan\nLast 4 Digit NRIC / UEN: 161E\nContact Number: 91234567\nEmail Address: jane@example.com\nEvent Type: Social");
  assert.equal(parsed.name, "Jane Tan");
  assert.equal(parsed.nric_last4, "161E");
  assert.equal(parsed.contact, "91234567");
});

// ---------------------------------------------------------------------------
// Kenneth's ACTUAL real WhatsApp templates, verbatim (2026-08-02) — the ones
// this whole §5b feature was built for. Emoji, spacing, and all. Sent as two
// variants of message 2 (his current promo, and the underlying default he
// clarified afterward) to prove extractDollarNear handles both amounts the
// same way, not just whichever one happened to be sent first.
// ---------------------------------------------------------------------------
const REAL_MSG_EVENT_DETAILS =
  "📅 Date Of Event:  21Aug26\n" +
  "⏰ No. Of Hours:  8hours \n" +
  "🕒 Start Time of Event:  11.00am\n" +
  "🎈 Type Of Event: Birthday (e.g. birthday, wedding, hens party, DnD etc.)";

const REAL_MSG_QUOTE_PROMO =
  "Usual rate: $180/hour\n" +
  "Package 8 hours: $150/hr \n" +
  "Total: $1200/-\n\n" +
  "Promo: Discount 10%\n" +
  "Final Price: $1080/-\n\n" +
  "Note there are 2 miscellaneous charges paid 1 week before booking\n\n" +
  "1) $61 Cleaning fee\n" +
  "2) $500 deposit (Refundable within 5 working days after the event)\n\n" +
  "Free setup: 30min pre setup n 15mins ending";

const REAL_MSG_QUOTE_DEFAULT =
  "Usual rate: $180/hour\n" +
  "Package 8 hours: $150/hr \n" +
  "Total: $1200/-\n\n" +
  "Note there are 2 miscellaneous charges paid 1 week before booking\n\n" +
  "1) $80 Cleaning fee\n" +
  "2) $500 deposit (Refundable within 5 working days after the event)\n\n" +
  "Free setup: 30min pre setup n 15mins ending";

const REAL_MSG_PARTICULARS =
  "👤 Name of Host (as in NRIC)/ Company:  Carine Liang\n" +
  "🆔 Last 4 Digit NRIC / UEN:  661A\n" +
  "📱 Contact Number:  93219316\n" +
  "📧 Email Address:  cake8485@gmail.com\n" +
  "✨ Event Type: Birthday";

test("detectWaTemplateType correctly classifies all 3 real messages despite emoji", () => {
  assert.equal(detectWaTemplateType(REAL_MSG_EVENT_DETAILS), "event_details");
  assert.equal(detectWaTemplateType(REAL_MSG_QUOTE_PROMO), "quote");
  assert.equal(detectWaTemplateType(REAL_MSG_PARTICULARS), "particulars");
});

test("parseWaEventDetails: real message — emoji-prefixed labels, '11.00am' time, hint-suffixed event type", () => {
  const parsed = parseWaEventDetails(REAL_MSG_EVENT_DETAILS);
  assert.equal(parsed.date_of_event, "21Aug26");
  assert.equal(parsed.hours, "8hours");
  assert.equal(parsed.start_time, "11.00am");
  assert.equal(parsed.event_type, "Birthday (e.g. birthday, wedding, hens party, DnD etc.)");
});

test("parseWaQuote: real promo message — numbered-list cleaning fee/deposit, no colon", () => {
  const parsed = parseWaQuote(REAL_MSG_QUOTE_PROMO);
  assert.equal(parsed.package_hours, "8");
  assert.equal(parsed.package_rate, "150");
  assert.equal(parsed.discount_percent, "10");
  assert.equal(parsed.cleaning_fee, "61");
  assert.equal(parsed.deposit_amount, "500");
});

test("parseWaQuote: real default (no-promo) message — same numbered-list shape, different cleaning fee, no discount", () => {
  const parsed = parseWaQuote(REAL_MSG_QUOTE_DEFAULT);
  assert.equal(parsed.package_hours, "8");
  assert.equal(parsed.package_rate, "150");
  assert.equal(parsed.discount_percent, null);
  assert.equal(parsed.cleaning_fee, "80");
  assert.equal(parsed.deposit_amount, "500");
});

test("parseWaParticulars: real message — emoji-prefixed labels, digit-containing NRIC label", () => {
  const parsed = parseWaParticulars(REAL_MSG_PARTICULARS);
  assert.equal(parsed.name, "Carine Liang");
  assert.equal(parsed.nric_last4, "661A");
  assert.equal(parsed.contact, "93219316");
  assert.equal(parsed.email, "cake8485@gmail.com");
  assert.equal(parsed.event_type, "Birthday");
});

test("waAccumulationToFields: full real 3-message accumulation (promo) — event_type forced to Social, occasion moved to purpose, hint stripped", () => {
  const acc = {
    event_details: parseWaEventDetails(REAL_MSG_EVENT_DETAILS),
    quote: parseWaQuote(REAL_MSG_QUOTE_PROMO),
    particulars: parseWaParticulars(REAL_MSG_PARTICULARS),
  };
  const fields = waAccumulationToFields(acc);
  assert.equal(fields.name, "Carine Liang");
  assert.equal(fields["nric/uen"], "661A");
  assert.equal(fields["event type"], "Social"); // pricing-engine selector, NOT the occasion
  assert.equal(fields.purpose, "Birthday"); // occasion, hint suffix stripped, lives here instead
  assert.equal(parseFlexibleDate(fields["date of event"]), "2026-08-21");
  assert.equal(parseLooseNumber(fields.duration), 8);
  assert.equal(parseFlexibleTime(fields["time start"]), "11:00");
  assert.equal(parseLooseNumber(fields.rate), 150);
  assert.equal(fields.discount, "10");
  assert.equal(parseLooseNumber(fields["cleaning fee"]), 61);
  assert.equal(parseLooseNumber(fields.deposit), 500);
  assert.equal(fields.contact, "93219316");
  assert.equal(fields.email, "cake8485@gmail.com");
});

test("waAccumulationToFields: full real 3-message accumulation (default, no promo) — cleaning fee differs, discount blank", () => {
  const acc = {
    event_details: parseWaEventDetails(REAL_MSG_EVENT_DETAILS),
    quote: parseWaQuote(REAL_MSG_QUOTE_DEFAULT),
    particulars: parseWaParticulars(REAL_MSG_PARTICULARS),
  };
  const fields = waAccumulationToFields(acc);
  assert.equal(fields["event type"], "Social");
  assert.equal(fields.purpose, "Birthday");
  assert.equal(fields.discount, "");
  assert.equal(parseLooseNumber(fields["cleaning fee"]), 80);
  assert.equal(parseLooseNumber(fields.deposit), 500);
});

console.log(`${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("Some tests FAILED — see above.");
} else {
  console.log("All tests passed.");
}
