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
  parseTelegramTemplate, parseFlexibleDate, parseLooseNumber,
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

test("waAccumulationToFields + downstream loose parsing round-trips correctly", () => {
  const acc = {
    event_details: { date_of_event: "21Aug26", hours: "8hours", start_time: "18:00", event_type: "Social" },
    quote: { package_rate: "150", discount_percent: null, cleaning_fee: "$80/-", deposit_amount: "$500/-" },
    particulars: { name: "Bug Fix Test", nric_last4: "161E", contact: "91006003", email: "test@example.com" },
  };
  const fields = waAccumulationToFields(acc);
  assert.equal(fields.name, "Bug Fix Test");
  assert.equal(parseFlexibleDate(fields["date of event"]), "2026-08-21");
  assert.equal(parseLooseNumber(fields.duration), 8);
  assert.equal(parseLooseNumber(fields.rate), 150);
  assert.equal(parseLooseNumber(fields["cleaning fee"]), 80);
  assert.equal(parseLooseNumber(fields.deposit), 500);
});

console.log(`${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("Some tests FAILED — see above.");
} else {
  console.log("All tests passed.");
}
