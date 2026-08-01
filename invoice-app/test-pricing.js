// Regression tests for src/pricing.js's isWeekend() — plain Node `assert`, no
// test framework dependency, same philosophy as test-parsing.js. Run with:
//   node test-pricing.js
//
// Added 2026-08-02 after Kenneth pointed at the real rate card
// (bojiovenue.com/#pricing) in response to a mismatch his own real quote
// exposed: isWeekend() only checked Sat/Sun, but the site's actual boundary
// is "Fri-Sun & PH" (confirmed on both the Social AND Corporate tabs) — a
// real booking for Friday 21 Aug 2026 was computing the wrong $150 weekday
// rate instead of $180.

import assert from "node:assert/strict";
import { isWeekend } from "./src/pricing.js";

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

test("isWeekend: Friday counts as weekend (real gap — Kenneth's real 21 Aug 2026 quote)", () => {
  assert.equal(isWeekend("2026-08-21"), true);
});
test("isWeekend: Saturday and Sunday still count", () => {
  assert.equal(isWeekend("2026-08-22"), true); // Sat
  assert.equal(isWeekend("2026-08-23"), true); // Sun
});
test("isWeekend: Monday-Thursday, no PH nearby, stays weekday", () => {
  assert.equal(isWeekend("2026-08-17"), false); // Mon
  assert.equal(isWeekend("2026-08-18"), false); // Tue
  assert.equal(isWeekend("2026-08-19"), false); // Wed
  assert.equal(isWeekend("2026-08-20"), false); // Thu
});

test("isWeekend: a genuine weekday Public Holiday counts as weekend (Hari Raya Haji, Wed 27 May 2026)", () => {
  assert.equal(isWeekend("2026-05-27"), true);
});
test("isWeekend: New Year's Day 2026 (Thursday) counts", () => {
  assert.equal(isWeekend("2026-01-01"), true);
});
test("isWeekend: Chinese New Year 2026 (Tue 17 Feb + Wed 18 Feb) both count", () => {
  assert.equal(isWeekend("2026-02-17"), true);
  assert.equal(isWeekend("2026-02-18"), true);
});
test("isWeekend: Eve of a weekday PH counts too (day before Hari Raya Haji, Tue 26 May 2026)", () => {
  assert.equal(isWeekend("2026-05-26"), true);
});
test("isWeekend: the day BEFORE the eve is an ordinary weekday, not swept in", () => {
  assert.equal(isWeekend("2026-05-25"), false); // Mon, 2 days before the PH
});
test("isWeekend: a PH that already falls on Fri/Sat/Sun doesn't need special-casing either way", () => {
  assert.equal(isWeekend("2026-08-09"), true); // National Day, Sunday
  assert.equal(isWeekend("2026-12-25"), true); // Christmas, Friday
});
test("isWeekend: holiday-in-lieu Monday is deliberately NOT treated as a PH (scoped judgment call)", () => {
  // 1 Jun 2026 is the in-lieu Monday for Vesak Day (31 May 2026, a Sunday).
  // Still true here, but ONLY because Jun 1 2026 happens to be a Monday two
  // days after the eve check would look — confirm it's NOT being picked up
  // via the PH set itself by checking a plain in-lieu Monday that is NOT
  // adjacent to any other rule: 10 Aug 2026 (National Day's in-lieu Monday).
  assert.equal(isWeekend("2026-08-10"), false); // Mon, in-lieu day, deliberately excluded
});

test("isWeekend: 2027 dates are also covered (Good Friday, Fri 26 Mar 2027)", () => {
  assert.equal(isWeekend("2027-03-26"), true);
});
test("isWeekend: dates beyond the maintained PH list (2028+) still get correct Fri/Sat/Sun coverage from the fallback", () => {
  assert.equal(isWeekend("2028-01-01"), true); // Saturday — caught by the plain day-of-week check alone
  assert.equal(isWeekend("2028-01-04"), false); // Tuesday, no PH data this far out, correctly not swept in
});

console.log(`${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("Some tests FAILED — see above.");
} else {
  console.log("All tests passed.");
}
