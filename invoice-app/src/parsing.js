// Pure text-parsing functions for Telegram booking intake — deterministic,
// no AI/LLM calls (project-wide $0-cost / no-model-misreads-a-real-invoice
// constraint), no Workers-runtime dependencies (no `env`, D1, fetch), so this
// module works identically inside the bundled Worker and under plain `node` —
// see test-parsing.js, added 2026-08-02 after a real dry-run bug report showed
// these needed actual regression coverage, not just ad-hoc manual testing.

// Label class includes ".()" and digits (not just letters/spaces/slash) so real
// WhatsApp-template labels like "No. Of Hours:", "Name of Host (as in NRIC)/
// Company:", and "Last 4 Digit NRIC / UEN:" all parse (Addendum 7). The digit
// "4" sits inside that last label itself, not just the value — without it in
// the class, the whole line silently failed to match and nric_last4 was always
// null on real input (2026-08-02, found by test-parsing.js). The label must
// still START with a letter (leading class stays [A-Za-z], not widened) so a
// bare time value like "18:00" on its own line is never misread as a label.
export function parseTelegramTemplate(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 /.()]*?)\s*:\s*(.*)$/);
    if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return fields;
}

// Accepts YYYY-MM-DD (§5a's strict format) or "D Mon YY[YY]" in any spacing —
// "21 Aug 2026", "21Aug2026", "21Aug26" all parse (2026-08-02 bug report: a real
// dry-run message used "21Aug26", no spaces, 2-digit year, which the original
// whitespace-and-4-digit-year-only regex rejected outright). Returns YYYY-MM-DD
// or null if nothing matches. Deliberately still narrow in one direction: a
// genuinely ambiguous numeric format (e.g. 08/09, which could be Aug 9 or Sep 8)
// is left unparsed rather than guessed at, same reasoning as the rest of this
// file's discount/date handling — only the SPACING/year-length is made lenient,
// not the fundamentally ambiguous cases.
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseFlexibleDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{2}|\d{4})$/);
  if (m) {
    const month = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${year}-${String(month + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
    }
  }
  return null;
}

// Extracts the first number out of a loosely-formatted value: strips a leading
// "$", thousands commas, a trailing "/-" (2026-08-02 bug report: a real
// WhatsApp-forward used "$1200/-"), and — for duration-style values — a trailing
// unit word ("hours"/"hrs"/"hr"/"h", e.g. "8hours"). Returns null (never NaN,
// never a silent 0) when nothing numeric is found, so callers can tell
// "genuinely not provided" apart from "provided but unreadable" and warn instead
// of guessing at a number that could be financially wrong.
export function parseLooseNumber(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/^\$\s*/, "").replace(/,/g, "").replace(/\/-\s*$/, "").replace(/\s*(hours?|hrs?|h)\s*$/i, "").trim();
  const m = cleaned.match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ---------------------------------------------------------------------------
// Addendum 7 (2026-08-01) — WhatsApp-quote-template accumulation, §5b. Kenneth
// forwards his existing WhatsApp templates verbatim as up to 3 separate
// messages; this detects which of the 3 a given message is and merges it into
// a per-chat accumulation (pending_wa_accumulation in worker.js) until all 3
// have arrived.
//
// ⚠ PROVISIONAL: the label text/regexes below are my best-effort match against
// the ABSTRACTED label list in SPEC.md §5b, not yet verified against a real
// forwarded message (still waiting on that from Kenneth — see SPEC.md's open
// item). Expect to refine once real examples arrive; until then a field that
// doesn't confidently parse is reported back as missing rather than guessed at.
// ---------------------------------------------------------------------------
export const WA_GROUP_LABELS = { event_details: "Event details", quote: "Quote", particulars: "Particulars" };

export function detectWaTemplateType(text) {
  if (/date\s*of\s*event/i.test(text)) return "event_details";
  if (/usual\s*rate/i.test(text) || /final\s*price/i.test(text)) return "quote";
  if (/name\s*of\s*host/i.test(text) || /last\s*4\s*digit/i.test(text)) return "particulars";
  return null;
}

export function parseWaEventDetails(text) {
  const f = parseTelegramTemplate(text);
  return {
    date_of_event: f["date of event"] || null,
    hours: f["no. of hours"] || f["no of hours"] || null,
    start_time: f["start time of event"] || null,
    event_type: f["type of event"] || null,
  };
}

export function parseWaQuote(text) {
  const f = parseTelegramTemplate(text);
  const packageMatch = text.match(/package\s+(\d+(?:\.\d+)?)\s*hours?\s*:\s*\$?\s*(\d+(?:\.\d+)?)\s*\/\s*hr/i);
  const discountMatch = text.match(/discount\s+(\d+(?:\.\d+)?)\s*%/i);
  return {
    usual_rate: f["usual rate"] || null,
    package_hours: packageMatch ? packageMatch[1] : null,
    package_rate: packageMatch ? packageMatch[2] : null,
    total: f["total"] || null,
    discount_percent: discountMatch ? discountMatch[1] : null,
    final_price: f["final price"] || null,
    cleaning_fee: f["cleaning fee"] || null,
    deposit_amount: f["deposit"] || f["security deposit"] || null,
  };
}

export function parseWaParticulars(text) {
  const f = parseTelegramTemplate(text);
  return {
    name: f["name of host (as in nric)/ company"] || f["name of host"] || f["company"] || null,
    nric_last4: f["last 4 digit nric / uen"] || f["last 4 digit nric/uen"] || null,
    contact: f["contact number"] || null,
    email: f["email address"] || null,
    event_type: f["event type"] || null,
  };
}

// Maps the 3 accumulated groups into stageBookingForConfirm's normalized field
// shape (worker.js). venue/purpose/"cleaning with" aren't captured by any of the
// 3 real templates — left blank, which stageBookingForConfirm already treats as
// sensible defaults (Whole Venue, no notes, cleaning billed with deposit).
export function waAccumulationToFields(acc) {
  const ed = acc.event_details || {};
  const q = acc.quote || {};
  const p = acc.particulars || {};
  return {
    name: p.name || "",
    "nric/uen": p.nric_last4 || "",
    "event type": ed.event_type || p.event_type || "",
    venue: "",
    "date of event": ed.date_of_event || "",
    "time start": ed.start_time || "",
    duration: ed.hours || "",
    purpose: "",
    rate: q.package_rate || "",
    discount: q.discount_percent || "",
    "cleaning fee": q.cleaning_fee || "",
    deposit: q.deposit_amount || "",
    "cleaning with": "",
    other: "",
    contact: p.contact || "",
    email: p.email || "",
  };
}
