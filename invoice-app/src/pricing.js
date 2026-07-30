// Venue pricing rules — sourced directly from the live site (bojiovenue.com/#pricing
// and its FAQ), confirmed as the authoritative current rates by Kenneth (2026-07-19).
// This replaces an earlier, incorrect flat-rate model — see README history.
//
// TWO COMPLETELY DIFFERENT PRICING ENGINES, selected by event_type:
//
// 1. SOCIAL — always Whole Venue (no Main Hall option exists for Social on the live
//    site). Priced from a fixed PACKAGE-DEAL lookup table (4-12h), NOT hours × a flat
//    rate — e.g. 8h Mon-Thu is a flat $800, not 8 × $150. Below 4h, or for a same-day
//    extension beyond a booked package, the plain hourly rate applies ($150/$180).
//    Deposit $500, cleaning fee $80 — always, regardless of anything else.
//
// 2. CORPORATE / SEMINAR — share the same engine (Seminar/Workshop confirmed to use
//    Corporate's rates, since the site has no separate Seminar rate card). Client
//    picks a venue_space (Whole Venue or Main Hall Only — Main Hall Only is NOT
//    offered on weekends, only Mon-Thu). Price is a genuine hours × rate, but the
//    rate itself depends on committing to a MINIMUM number of hours — book more,
//    get a lower rate. Below the lowest tier's minimum, a flat fallback rate applies.
//    Deposit $200, cleaning fee $50 — flat, regardless of which venue space.
//
// "Small Training Room" (mentioned in an old agreement PDF) does NOT exist on the
// current live site — confirmed dropped. Only Whole Venue and Main Hall Only exist.

export const EVENT_TYPES = ["Social", "Corporate", "Seminar"];
export const VENUE_SPACES = ["Whole Venue", "Main Hall Only"];

export const MIN_HOURS = 4; // Social minimum; Corporate/Seminar have their own per-tier minimums below

// ---------------------------------------------------------------------------
// SOCIAL — fixed package table. Keys are whole hours 4-12. Beyond 12h (rare —
// venue is open 8am-4am) there's no published tier, so we extrapolate at the
// 12h package's effective $/hr as a reasonable default — FLAG for Kenneth if
// this ever actually comes up, since it's not on the published rate card.
// ---------------------------------------------------------------------------
const SOCIAL_PACKAGES = {
  weekday: { 4: 520, 5: 600, 6: 720, 7: 840, 8: 800, 9: 900, 10: 1000, 11: 1100, 12: 1200 },
  weekend: { 4: 640, 5: 800, 6: 900, 7: 1050, 8: 1200, 9: 1260, 10: 1400, 11: 1540, 12: 1680 },
};
const SOCIAL_HOURLY_RATE = { weekday: 150, weekend: 180 }; // <4h, same-day extension, or >12h fallback
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

function socialQuote(dateStr, hours) {
  const dayKey = isWeekend(dateStr) ? "weekend" : "weekday";
  const table = SOCIAL_PACKAGES[dayKey];
  const flatRate = SOCIAL_HOURLY_RATE[dayKey];
  let rental_total;
  if (hours in table) {
    rental_total = table[hours];
  } else if (hours > 12) {
    rental_total = round2((table[12] / 12) * hours); // extrapolated — not an official rate
  } else {
    rental_total = round2(flatRate * hours); // <4h edge case
  }
  return {
    hourly_rate: round2(rental_total / hours), // effective/blended rate for display
    rental_total,
    cleaning_fee: SOCIAL_CLEANING_FEE,
    deposit_amount: SOCIAL_DEPOSIT,
  };
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
// PROMO PRESETS (added 2026-08-03). A promo is defined once (see db.js/promos
// table) and auto-applies to any new booking whose booking_date falls inside
// [valid_from, valid_to] while active=1 — Kenneth doesn't type anything special
// for it to kick in. Layering, in order (each layer can be skipped/overridden):
//   1. Standard auto price (socialQuote/corporateQuote above)
//   2. Promo adjustment, if one is active for this date (this function)
//   3. Manual override (hourly_rate/cleaning_fee explicitly passed) — ALWAYS wins,
//      even over an active promo, per Kenneth's explicit requirement.
// ---------------------------------------------------------------------------

// Picks the applicable promo for a date from a list (db.listActivePromos already
// filters to active=1; this does the date-window check). If more than one
// overlaps — shouldn't normally happen — the most recently-starting one wins.
export function findActivePromo(promos, booking_date) {
  const matches = (promos || []).filter((p) => booking_date >= p.valid_from && booking_date <= p.valid_to);
  if (!matches.length) return null;
  return matches.sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
}

// Applies a promo on top of an auto-computed {hourly_rate, rental_total, cleaning_fee}.
// discount_percent and extra_discount_amount both come off the RENTAL fee (confirmed
// against the Nirmala example: $900 standard weekend 6h rental x 0.9 = $810 exactly).
// cleaning_fee_override replaces the cleaning fee outright, not a percentage.
function applyPromo(auto, promo, hours) {
  if (!promo) return auto;
  let rental = auto.rental_total;
  if (promo.discount_percent) rental = round2(rental * (1 - promo.discount_percent / 100));
  if (promo.extra_discount_hours_threshold && hours >= promo.extra_discount_hours_threshold) {
    rental = round2(rental - (promo.extra_discount_amount || 0));
  }
  const cleaning = promo.cleaning_fee_override ?? auto.cleaning_fee;
  return {
    hourly_rate: round2(rental / hours), // recompute the effective/display rate for the new total
    rental_total: rental,
    cleaning_fee: cleaning,
    deposit_amount: auto.deposit_amount, // promos in this spec never touch the deposit
  };
}

// Parse a free-text discount description (e.g. from the Telegram "Other" field) into
// a flat dollar amount. Only acts on patterns it's confident about — anything it can't
// parse returns amount 0 with the raw text preserved as a note, so an unrecognized
// discount NEVER silently changes a real invoice total. Kenneth can always apply it
// manually afterward via the admin form's deposit/cleaning/hourly_rate overrides, or
// by editing the invoice's discount before signing.
export function parseDiscount(text, subtotal) {
  const raw = (text || "").trim();
  if (!raw) return { amount: 0, note: "" };
  const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return { amount: round2((Number(pct[1]) / 100) * subtotal), note: raw };
  const dollar = raw.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (dollar && /off|discount|less|-/i.test(raw)) return { amount: Number(dollar[1]), note: raw };
  return { amount: 0, note: raw }; // couldn't confidently parse — leave for manual review
}

// Compute the money side. Any of hourly_rate / cleaning_fee / deposit_amount may be
// passed to override the auto-derived defaults — the admin form always allows manual
// override for edge cases (e.g. Main Hall Only on a weekend, >12h Social bookings),
// and this ALWAYS wins even over an active promo.
//
// `promo` (optional): a row from the promos table (or null). If given and its date
// window covers booking_date, its adjustment applies as the middle layer, between
// the standard auto price and any manual override — see applyPromo() above.
//
// grand_total = rental_total + cleaning_fee + pet_fee - discount. The deposit is
// tracked separately and deliberately excluded — it's refundable, not revenue.
export function computeQuote({ event_type, venue_space, booking_date, hours, hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount, promo }) {
  const billedHours = Math.max(Number(hours) || 0, MIN_HOURS);
  const standardAuto =
    event_type === "Social"
      ? socialQuote(booking_date, billedHours)
      : corporateQuote(booking_date, billedHours, venue_space);
  const promoActive = promo && booking_date >= promo.valid_from && booking_date <= promo.valid_to;
  const auto = promoActive ? applyPromo(standardAuto, promo, billedHours) : standardAuto;

  const rate = numOr(hourly_rate, auto.hourly_rate);
  const clean = numOr(cleaning_fee, auto.cleaning_fee);
  const deposit = numOr(deposit_amount, auto.deposit_amount);
  const pet = numOr(pet_fee, 0);
  const disc = numOr(discount, 0);
  const rental_total = hourly_rate !== undefined && hourly_rate !== null && hourly_rate !== ""
    ? round2(rate * billedHours) // manual rate override -> recompute total linearly
    : auto.rental_total;
  const grand_total = Math.max(0, round2(rental_total + clean + pet - disc));

  return {
    hourly_rate: rate,
    hours: billedHours,
    cleaning_fee: clean,
    deposit_amount: deposit,
    pet_fee: pet,
    discount: disc,
    rental_total,
    grand_total,
    // Only surfaced when the promo actually applied (and wasn't itself overridden
    // away) — callers use these to prefill rental_fee_note/cleaning_fee_note/
    // promo_clause_title/promo_clause_text/promo_id unless already set explicitly.
    appliedPromo: promoActive ? promo : null,
  };
}

function numOr(v, fallback) {
  return v === undefined || v === null || v === "" || isNaN(Number(v)) ? fallback : Number(v);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
