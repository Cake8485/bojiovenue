// Venue pricing rules — sourced directly from the live site (bojiovenue.com/#pricing
// and its FAQ), confirmed as the authoritative current rates by Kenneth (2026-07-19).
//
// TWO COMPLETELY DIFFERENT PRICING ENGINES, selected by event_type:
//
// 1. SOCIAL — always Whole Venue (no Main Hall option exists for Social on the live
//    site). Rewritten Addendum 3 (2026-08-10) to mirror exactly how Kenneth quotes
//    over WhatsApp — three layers, all shown on the Agreement:
//      usual rate (auto, by day of week) x package rate (the rate actually charged
//      this booking) x hours = subtotal, then a discount % on top -> final rental.
//    This REPLACES the old fixed package-lookup table (e.g. "8h Mon-Thu = flat
//    $800"), which hid the real math behind a single number. Deposit $500, cleaning
//    fee $80 — always, regardless of anything else (unless a promo overrides cleaning).
//
// 2. CORPORATE / SEMINAR — share the same engine (Seminar/Workshop confirmed to use
//    Corporate's rates, since the site has no separate Seminar rate card). Client
//    picks a venue_space (Whole Venue or Main Hall Only — Main Hall Only is NOT
//    offered on weekends, only Mon-Thu). Price is a genuine hours × rate, but the
//    rate itself depends on committing to a MINIMUM number of hours — book more,
//    get a lower rate. Below the lowest tier's minimum, a flat fallback rate applies.
//    Deposit $200, cleaning fee $50 — flat, regardless of which venue space.
//    UNCHANGED by Addendum 3 (scoped to Social only) — still a flat $ discount and
//    no promo awareness.
//
// "Small Training Room" (mentioned in an old agreement PDF) does NOT exist on the
// current live site — confirmed dropped. Only Whole Venue and Main Hall Only exist.

export const EVENT_TYPES = ["Social", "Corporate", "Seminar"];
export const VENUE_SPACES = ["Whole Venue", "Main Hall Only"];

export const MIN_HOURS = 4; // Social minimum; Corporate/Seminar have their own per-tier minimums below

// ---------------------------------------------------------------------------
// SOCIAL — usual rate by day of week. This IS the "usual rate" shown on the
// Agreement breakdown; the actual "package rate" charged may differ (see
// socialFullQuote below).
// ---------------------------------------------------------------------------
const SOCIAL_HOURLY_RATE = { weekday: 150, weekend: 180 };
export const SOCIAL_DEPOSIT = 500;
export const SOCIAL_CLEANING_FEE = 80;

// ---------------------------------------------------------------------------
// CORPORATE / SEMINAR — minimum-hour commitment tiers. Listed highest-minimum
// first so the first tier the booking qualifies for wins (more hours = better
// rate). Main Hall Only has no weekend tier at all (not offered).
// "Below min purchase: $90/hour" is shown once on the site, not per-card — read
// as ONE flat fallback for the whole Corporate/Seminar tab. FLAG for Kenneth to
// confirm if this assumption is wrong.
// ---------------------------------------------------------------------------
const CORPORATE_TIERS = {
  "Whole Venue": {
    weekday: [{ min: 25, rate: 70 }, { min: 15, rate: 90 }],
    weekend: [{ min: 25, rate: 100 }, { min: 15, rate: 120 }],
  },
  "Main Hall Only": {
    weekday: [{ min: 20, rate: 55 }, { min: 10, rate: 70 }],
    weekend: null, // not offered — booking must fall back to Whole Venue or a manual rate
  },
};
const CORPORATE_BELOW_MIN_RATE = 90;
export const CORPORATE_DEPOSIT = 200;
export const CORPORATE_CLEANING_FEE = 50;

export const PET_CLEANING_FEE = 100; // optional, added on top when the pet checkbox is set

export function isWeekend(dateStr) {
  // dateStr = YYYY-MM-DD. Treat as local date; Sat(6)/Sun(0) = weekend.
  // NOTE: the live site's actual weekend boundary is "Fri-Sun & PH" for Social
  // (i.e. Friday counts as weekend too) — this simple Sat/Sun check does NOT
  // yet account for Friday or public holidays. Flagged as a known gap.
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

function socialUsualRate(dateStr) {
  return isWeekend(dateStr) ? SOCIAL_HOURLY_RATE.weekend : SOCIAL_HOURLY_RATE.weekday;
}

function corporateQuote(dateStr, hours, venue_space) {
  const dayKey = isWeekend(dateStr) ? "weekend" : "weekday";
  const tiers = CORPORATE_TIERS[venue_space]?.[dayKey];
  let rate;
  if (!tiers) {
    // e.g. Main Hall Only on a weekend — not offered on the published rate card.
    // Fall back to the below-minimum flat rate rather than silently guessing higher.
    rate = CORPORATE_BELOW_MIN_RATE;
  } else {
    const tier = tiers.find((t) => hours >= t.min);
    rate = tier ? tier.rate : CORPORATE_BELOW_MIN_RATE;
  }
  return {
    hourly_rate: rate,
    rental_total: round2(rate * hours),
    cleaning_fee: CORPORATE_CLEANING_FEE,
    deposit_amount: CORPORATE_DEPOSIT,
  };
}

// ---------------------------------------------------------------------------
// PROMO PRESETS (added 2026-08-03, re-scoped Addendum 3). A promo is defined
// once (see db.js/promos table) and applies ONLY to Social bookings whose
// booking_date falls inside [valid_from, valid_to] while active=1 — it's a
// QUICK-FILL for package rate / discount % / cleaning fee, not an independent
// stacking layer: Kenneth's own Rate:/Discount: input (Telegram or admin form)
// always wins over the promo's suggestion, field by field. Corporate/Seminar
// bookings never look at promos at all.
// ---------------------------------------------------------------------------

// Picks the applicable promo for a date from a list (db.listActivePromos already
// filters to active=1; this does the date-window check). If more than one
// overlaps — shouldn't normally happen — the most recently-starting one wins.
export function findActivePromo(promos, booking_date) {
  const matches = (promos || []).filter((p) => booking_date >= p.valid_from && booking_date <= p.valid_to);
  if (!matches.length) return null;
  return matches.sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
}

// Social pricing (rewritten Addendum 3): usual_rate x package_rate x hours =
// rental_subtotal, then discount_percent on top -> rental_total (already NET of
// discount — unlike Corporate below, nothing further is subtracted at grand_total).
// package_rate/discount_percent/cleaning_fee each independently fall back, in
// order: explicit input -> active promo's suggestion -> plain default.
//
// The old SG61-style "extra flat $ off if hours >= threshold" mechanic is kept as
// a supplementary adjustment (applied after the percent discount) so existing
// promos built around it keep producing the exact same numbers under the new model.
function socialFullQuote({ booking_date, hours, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount_percent, promo }) {
  const usual_rate = socialUsualRate(booking_date);
  const promoActive = promo && booking_date >= promo.valid_from && booking_date <= promo.valid_to;

  const package_rate = numOr(hourly_rate, promoActive ? numOr(promo.package_rate, usual_rate) : usual_rate);
  const rental_subtotal = round2(package_rate * hours);

  const pct = numOr(discount_percent, promoActive ? promo.discount_percent || 0 : 0);
  let discountAmt = round2((rental_subtotal * pct) / 100);
  if (promoActive && promo.extra_discount_hours_threshold && hours >= promo.extra_discount_hours_threshold) {
    discountAmt = round2(discountAmt + (promo.extra_discount_amount || 0));
  }

  const rental_total = Math.max(0, round2(rental_subtotal - discountAmt));
  const clean = numOr(cleaning_fee, promoActive ? promo.cleaning_fee_override ?? SOCIAL_CLEANING_FEE : SOCIAL_CLEANING_FEE);
  const deposit = numOr(deposit_amount, SOCIAL_DEPOSIT);
  const pet = numOr(pet_fee, 0);
  const grand_total = Math.max(0, round2(rental_total + clean + pet));

  return {
    usual_rate,
    hourly_rate: package_rate,
    rental_subtotal,
    discount_percent: pct,
    discount: discountAmt,
    hours,
    cleaning_fee: clean,
    deposit_amount: deposit,
    pet_fee: pet,
    rental_total,
    grand_total,
    appliedPromo: promoActive ? promo : null,
  };
}

// Corporate/Seminar — unchanged behaviour, just reshaped to return the same fields
// as socialFullQuote (usual_rate/rental_subtotal/discount_percent are inert here).
function corporateFullQuote({ booking_date, hours, venue_space, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount }) {
  const auto = corporateQuote(booking_date, hours, venue_space);
  const rate = numOr(hourly_rate, auto.hourly_rate);
  const clean = numOr(cleaning_fee, auto.cleaning_fee);
  const deposit = numOr(deposit_amount, auto.deposit_amount);
  const pet = numOr(pet_fee, 0);
  const disc = numOr(discount, 0);
  const rental_total =
    hourly_rate !== undefined && hourly_rate !== null && hourly_rate !== ""
      ? round2(rate * hours) // manual rate override -> recompute total linearly
      : auto.rental_total;
  const grand_total = Math.max(0, round2(rental_total + clean + pet - disc));

  return {
    usual_rate: null,
    hourly_rate: rate,
    rental_subtotal: rental_total, // no separate percent-discount layer for Corporate
    discount_percent: 0,
    discount: disc,
    hours,
    cleaning_fee: clean,
    deposit_amount: deposit,
    pet_fee: pet,
    rental_total,
    grand_total,
    appliedPromo: null,
  };
}

// Parse a free-text discount description (e.g. Corporate's "Other:" field, or the
// admin form's flat discount box) into a flat dollar amount. Only acts on patterns
// it's confident about — anything it can't parse returns amount 0 with the raw text
// preserved as a note, so an unrecognized discount NEVER silently changes a real
// invoice total. Social bookings use the dedicated Discount:(%) field instead (see
// parsePercent) — this stays in use for Corporate only.
export function parseDiscount(text, subtotal) {
  const raw = (text || "").trim();
  if (!raw) return { amount: 0, note: "" };
  const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return { amount: round2((Number(pct[1]) / 100) * subtotal), note: raw };
  const dollar = raw.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (dollar && /off|discount|less|-/i.test(raw)) return { amount: Number(dollar[1]), note: raw };
  return { amount: 0, note: raw }; // couldn't confidently parse — leave for manual review
}

// Parses the dedicated Social "Discount: (%)" field (Telegram or admin form) — a
// plain number, optionally with a trailing "%". Deliberately NOT fuzzy like
// parseDiscount(): anything that doesn't look like a bare percentage is treated as
// 0 rather than guessed at, since this number directly changes what's shown on a
// real signed Agreement.
export function parsePercent(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return 0;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) : 0;
}

// Compute the money side. `promo` (optional): a row from the promos table (or
// null) — only ever consulted for Social bookings; see socialFullQuote above.
//
// grand_total = rental_total + cleaning_fee + pet_fee, MINUS discount for
// Corporate only (Social's rental_total is already net of its discount — see the
// schema.sql comment above the invoices table for why the two engines differ here).
export function computeQuote({ event_type, venue_space, booking_date, hours, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount_percent, discount, promo }) {
  const billedHours = Math.max(Number(hours) || 0, MIN_HOURS);
  if (event_type === "Social") {
    return socialFullQuote({ booking_date, hours: billedHours, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount_percent, promo });
  }
  return corporateFullQuote({ booking_date, hours: billedHours, venue_space, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount });
}

function numOr(v, fallback) {
  return v === undefined || v === null || v === "" || isNaN(Number(v)) ? fallback : Number(v);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
