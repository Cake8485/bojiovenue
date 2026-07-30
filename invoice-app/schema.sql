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
  hourly_rate          REAL    NOT NULL,                 -- for Social this is a blended/effective rate (package_total / hours), not a nominal rate
  cleaning_fee         REAL    NOT NULL DEFAULT 0,
  deposit_amount       REAL    NOT NULL DEFAULT 0,        -- SEPARATE refundable security deposit — never netted into grand_total or balance owed
  pet_fee              REAL    NOT NULL DEFAULT 0,        -- optional $100 add-on, checkbox on the invoice form
  discount             REAL    NOT NULL DEFAULT 0,        -- flat $ off the booking invoice total (parsed from % or $ input)
  discount_note         TEXT,                             -- raw text describing the discount (e.g. "10% loyalty discount"), for audit
  rental_total         REAL    NOT NULL,                 -- Social: package lookup. Corporate/Seminar: hourly_rate * hours.
  grand_total          REAL    NOT NULL,                 -- rental_total + cleaning_fee + pet_fee - discount (deposit deliberately excluded) -- this is the "Booking Invoice" total

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

  -- Three separate PDFs get filed to Drive once the agreement is signed (not one combined doc)
  drive_agreement_file_id       TEXT,
  drive_booking_invoice_file_id TEXT,
  drive_deposit_invoice_file_id TEXT,

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
