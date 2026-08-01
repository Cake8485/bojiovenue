-- BojioVenue D1 schema.
-- One document, status-driven (invoice + receipt in one). See README for rationale.

-- Promo presets (added 2026-08-03). Defined once, auto-applied to new bookings
-- whose booking_date falls within [valid_from, valid_to] and where active=1.
-- Only one promo is expected active at a time in practice, but the pricing engine
-- just takes the first match ordered by valid_from DESC if more than one overlaps.
CREATE TABLE IF NOT EXISTS promos (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT    NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,  -- manual kill-switch, independent of the date window
  valid_from                TEXT    NOT NULL,            -- YYYY-MM-DD, inclusive
  valid_to                  TEXT    NOT NULL,            -- YYYY-MM-DD, inclusive
  discount_percent          REAL    NOT NULL DEFAULT 0,  -- % off the standard rental fee
  cleaning_fee_override     REAL,                        -- flat replacement for the standard cleaning fee, NULL = no override
  extra_discount_hours_threshold REAL,                   -- e.g. 8 — booking must be >= this many hours
  extra_discount_amount     REAL    NOT NULL DEFAULT 0,  -- extra flat $ off rental if hours >= threshold
  package_rate              REAL,                        -- optional Social $/hr suggestion (added Addendum 3); NULL = suggest the usual weekday/weekend rate
  rental_fee_note           TEXT,                        -- shown in parentheses next to Rental Fee on the agreement
  cleaning_fee_note         TEXT,                        -- shown in parentheses next to Cleaning Fee
  clause_title              TEXT,                        -- inserted as clause 5.6/4.6, if set
  clause_text               TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  seq                  INTEGER NOT NULL UNIQUE,          -- gapless sequence: 1, 2, 3, ...
  invoice_no           TEXT    NOT NULL UNIQUE,          -- display form, e.g. 'INV-001'
  token                TEXT    NOT NULL UNIQUE,          -- unguessable signing-link token
  status               TEXT    NOT NULL DEFAULT 'issued',-- issued | signed | void

  -- Client (fresh entry each time — no stored customer list, per spec)
  client_name          TEXT    NOT NULL,
  client_phone         TEXT,
  client_email         TEXT,
  client_nric_uen      TEXT,                              -- for the agreement; optional

  -- Booking
  -- Pricing engine is picked by event_type: Social = fixed package-deal table (always
  -- Whole Venue); Corporate/Seminar = minimum-hour-commitment tiers (venue_space choice
  -- applies). See pricing.js for the full rules, sourced from bojiovenue.com.
  event_type           TEXT    NOT NULL,                 -- Social | Corporate | Seminar
  venue_space           TEXT    NOT NULL,                 -- Whole Venue | Main Hall Only (Social is always Whole Venue; Main Hall Only is Corporate/Seminar-only, weekday-only)
  booking_date         TEXT    NOT NULL,                 -- YYYY-MM-DD (event date; drives month folder + filename)
  start_time           TEXT,
  end_time             TEXT,
  hours                REAL    NOT NULL,                 -- billed hours (>= 4h minimum)

  -- Money (no GST — not registered)
  -- Social pricing (rewritten Addendum 3, 2026-08-10): usual_rate (auto, weekday
  -- $150/weekend $180) x hourly_rate (the "package rate" actually charged, manual
  -- or promo-suggested) x hours = rental_subtotal, then discount_percent applied on
  -- top -> rental_total. This replaces the old fixed package-lookup table so the
  -- agreement can show the full breakdown Kenneth already gives clients over
  -- WhatsApp: usual rate, package rate, subtotal, discount %, final price.
  -- Corporate/Seminar is UNCHANGED: hourly_rate is the tier rate, rental_total =
  -- hourly_rate * hours, and `discount`/`discount_note` (flat $, parsed from free
  -- text) is subtracted at the grand_total step instead — usual_rate/rental_subtotal/
  -- discount_percent are simply NULL/0 for these bookings.
  usual_rate           REAL,                              -- Social only: the weekday/weekend reference rate at booking time, for display
  hourly_rate          REAL    NOT NULL,                 -- Social: the package rate actually charged. Corporate/Seminar: the tier rate.
  rental_subtotal      REAL,                              -- Social: hourly_rate * hours, BEFORE discount_percent. Corporate: same as rental_total (no percent layer).
  discount_percent     REAL    NOT NULL DEFAULT 0,        -- Social only: % off rental_subtotal, manual or promo-suggested
  cleaning_fee         REAL    NOT NULL DEFAULT 0,
  deposit_amount       REAL    NOT NULL DEFAULT 0,        -- SEPARATE refundable security deposit — never netted into grand_total or balance owed
  pet_fee              REAL    NOT NULL DEFAULT 0,        -- optional $100 add-on, checkbox on the invoice form
  discount             REAL    NOT NULL DEFAULT 0,        -- Social: dollar amount discount_percent works out to (informational). Corporate: flat $ off (parsed from % or $ input) subtracted at grand_total.
  discount_note         TEXT,                             -- raw text describing the discount (e.g. "10% loyalty discount"), for audit
  rental_total         REAL    NOT NULL,                 -- FINAL rental fee. Social: rental_subtotal - discount, already net. Corporate/Seminar: hourly_rate * hours, gross (discount subtracted later at grand_total).
  grand_total          REAL    NOT NULL,                 -- Social: rental_total + cleaning_fee + pet_fee (discount already baked into rental_total). Corporate: rental_total + cleaning_fee + pet_fee - discount. This is the "Booking Invoice" total.

  -- Promo labels shown in parentheses next to each line item on the Agreement
  -- (e.g. "Rental Fee: $810 (SG61 x BoJio Turns One Promo)") — cosmetic only,
  -- the actual amount is whatever hourly_rate/cleaning_fee/deposit_amount/pet_fee
  -- were manually overridden to.
  rental_fee_note      TEXT,
  cleaning_fee_note    TEXT,
  deposit_note         TEXT,
  pet_fee_note         TEXT,
  -- An optional custom clause (e.g. a promo's override of standard cancellation
  -- terms) inserted into the Agreement as clause 5.6 (Whole Venue) / 4.6 (Main
  -- Hall), right after the standard cancellation section.
  promo_clause_title   TEXT,
  promo_clause_text    TEXT,
  promo_id             INTEGER REFERENCES promos(id), -- which preset auto-applied, if any (audit trail)

  -- Status (three independent fields — rental payment, cleaning fee, and the refundable deposit are separate concerns)
  payment_status       TEXT    NOT NULL DEFAULT 'Unpaid',      -- Unpaid | Partially Paid | Paid  (rental total only)
  cleaning_fee_status  TEXT    NOT NULL DEFAULT 'Unpaid',      -- Unpaid | Paid
  deposit_status       TEXT    NOT NULL DEFAULT 'Not Collected', -- Not Collected | Held | Refunded

  notes                TEXT,

  -- Signing
  signature_png        TEXT,                             -- base64 PNG data URL captured in-browser
  signer_name          TEXT,
  signed_at            TEXT,

  -- Drive folder structure (rewritten Addendum 5, 2026-08-01): month folder (by
  -- event date) -> one subfolder per booking ({invoice_no}_{ClientName}_{DDMon}) ->
  -- every document for this booking lives inside. Stored once the folder is first
  -- created so repeated filing (and the postpone command's folder move) hit this ID
  -- directly instead of re-searching Drive by name every time.
  drive_booking_folder_id       TEXT,

  -- Three separate PDFs get filed to Drive once the agreement is signed (not one combined doc)
  drive_agreement_file_id       TEXT,
  drive_booking_invoice_file_id TEXT,
  drive_deposit_invoice_file_id TEXT,
  -- Receipts (added Addendum 3) — distinct documents from the invoices above, filed
  -- only once the corresponding payment is actually confirmed via Telegram, not at
  -- signing time. Invoice = bill (what's owed); Receipt = proof of payment received.
  drive_rental_receipt_file_id  TEXT,
  drive_deposit_receipt_file_id TEXT,

  -- Payment-event timestamps (added Addendum 3) — each is set once, the first time
  -- its status command is applied; re-applying the same command does not move them.
  -- Needed both for the receipts (payment date) and for stage tracking / reminders.
  sent_at                    TEXT,  -- when Kenneth tapped "Send signing link" in Telegram
  rental_paid_at             TEXT,  -- when "INV-XXX rental paid" was first applied
  deposit_paid_at            TEXT,  -- when "INV-XXX deposit paid" was first applied
  deposit_refunded_at        TEXT,  -- when "INV-XXX deposit refunded" was first applied
  -- One-time markers so the daily cron reminder doesn't re-nag about the same
  -- booking every day once the threshold is crossed.
  unsigned_reminder_sent_at  TEXT,
  deposit_reminder_sent_at   TEXT,
  refund_reminder_sent_at    TEXT,  -- added Addendum 4: event past, deposit held, refund overdue (Clause 8.1)

  -- Refund proof (added Addendum 4) — Kenneth forwards his bank transfer screenshot
  -- to the bot after paying out (Path A, or the balance after a deduction); filed to
  -- the same month folder as everything else for this booking.
  drive_refund_proof_file_id TEXT,

  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Dated payment log (audit trail). Current status is set by Kenneth; this is the history.
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  amount       REAL    NOT NULL,
  kind         TEXT    NOT NULL,          -- deposit | balance | cleaning_fee | refund | other
  paid_on      TEXT    NOT NULL,          -- YYYY-MM-DD
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(status);

-- Security Deposit Deductions (added Addendum 4, 2026-08-17) — Clause 8.3/8.4's
-- "Security Deposit Deduction Addendum". A booking can have MORE than one (damage
-- discovered over a few days is plausible), so this is its own table rather than
-- columns on invoices. Each deduction gets its own signing-style acknowledgment
-- link (SAME canvas-signature UI as the Agreement, per Kenneth's own description),
-- and its "balance refundable" line accounts for any earlier deductions on the same
-- booking (see deductions.js's running-balance calc), not just itself in isolation.
-- After acknowledgment, the balance is due within 3 working days (Clause 8.4); the
-- actual payout still goes through the SAME "INV-XXX refunded" + screenshot flow as
-- a plain no-deduction refund — this table only tracks the deduction paperwork, not
-- the payout itself (that's deposit_status/deposit_refunded_at on invoices).
CREATE TABLE IF NOT EXISTS deductions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id        INTEGER NOT NULL REFERENCES invoices(id),
  token             TEXT    NOT NULL UNIQUE,          -- unguessable acknowledgment-link token
  amount            REAL    NOT NULL,
  reason             TEXT    NOT NULL,                 -- breach nature / remarks, from "INV-XXX deduct 150 reason: ..."
  status             TEXT    NOT NULL DEFAULT 'pending', -- pending | acknowledged
  signature_png      TEXT,                              -- captured the same way as the Agreement's signature
  acknowledger_name  TEXT,
  acknowledged_at    TEXT,
  drive_file_id      TEXT,                              -- filed to Drive only once acknowledged, matching the Agreement's own "signed record" precedent
  reminder_sent_at   TEXT,                               -- one-time "balance due" cron marker (Clause 8.4, 3 working days after acknowledged_at)
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deductions_invoice ON deductions(invoice_id);

-- Staging area for the Telegram "confirm before creating anything" flow. A parsed
-- + priced booking is held here (NOT yet an invoice, no number burned) until Kenneth
-- taps Confirm on the inline-button reply. `data` is the full computed booking as
-- JSON. Telegram callback_data is limited to 64 bytes, so this row's small integer
-- `id` is what round-trips through the button instead of the booking itself.
CREATE TABLE IF NOT EXISTS pending_bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT    NOT NULL,
  data         TEXT    NOT NULL, -- JSON blob: all fields createInvoice() needs
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
