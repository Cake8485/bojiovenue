-- BojioVenue D1 schema.
-- One document, status-driven (invoice + receipt in one). See README for rationale.

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
