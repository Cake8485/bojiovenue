// D1 data access. All SQL lives here.
//
// GAPLESS NUMBERING (the tricky requirement):
// Addendum 6 (2026-08-24): the booking number is YEAR-SCOPED — {booking_year}
// {booking_seq, zero-padded 3} e.g. '2026036' — derived INSIDE a single INSERT:
//     booking_seq = COALESCE(MAX(booking_seq) WHERE booking_year=?, seed, 0) + 1
// Because D1 serialises writes to the database, this is atomic: either the row is
// inserted with the next number, or nothing is inserted (no gap is ever burned by a
// failed insert). Cancelled bookings become status='void' records that KEEP their
// number, so the sequence stays gapless with a full audit trail. `booking_no_seed`
// (see schema.sql) supplies the floor for a year with no rows yet, so this year's
// numbers continue above Kenneth's pre-existing Zoho receipt history.

function randomToken() {
  // 32 hex chars, unguessable. crypto is available in the Workers runtime.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createInvoice(env, d) {
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO invoices
       (booking_year, booking_seq, booking_no, token, status,
        client_name, client_phone, client_email, client_nric_uen,
        event_type, venue_space, booking_date, start_time, end_time, hours,
        usual_rate, hourly_rate, rental_subtotal, discount_percent,
        cleaning_fee, cleaning_fee_with, deposit_amount, pet_fee, discount, discount_note, rental_total, grand_total,
        rental_fee_note, cleaning_fee_note, deposit_note, pet_fee_note, promo_clause_title, promo_clause_text, promo_id, notes)
     SELECT y, n,
            CAST(y AS TEXT) || printf('%03d', n),
            ?, 'issued',
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
     FROM (
       -- '+8 hours' shifts to Singapore local time (UTC+8, no DST) before reading the
       -- year, so a booking made right around UTC midnight on Dec 31/Jan 1 still gets
       -- the year Kenneth would actually expect.
       SELECT y, COALESCE(
                   (SELECT MAX(booking_seq) FROM invoices WHERE booking_year = y),
                   (SELECT start_seq FROM booking_no_seed WHERE booking_year = y),
                   0
                 ) + 1 AS n
       FROM (SELECT CAST(strftime('%Y', 'now', '+8 hours') AS INTEGER) AS y)
     )`
  )
    .bind(
      token,
      d.client_name, d.client_phone, d.client_email, d.client_nric_uen,
      d.event_type, d.venue_space, d.booking_date, d.start_time, d.end_time, d.hours,
      d.usual_rate ?? null, d.hourly_rate, d.rental_subtotal ?? null, d.discount_percent || 0,
      d.cleaning_fee, d.cleaning_fee_with || "deposit", d.deposit_amount, d.pet_fee, d.discount, d.discount_note, d.rental_total, d.grand_total,
      d.rental_fee_note || null, d.cleaning_fee_note || null, d.deposit_note || null, d.pet_fee_note || null,
      d.promo_clause_title || null, d.promo_clause_text || null, d.promo_id || null, d.notes
    )
    .run();
  return getInvoiceByToken(env, token);
}

export function getInvoiceByToken(env, token) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE token = ?`).bind(token).first();
}

export function getInvoiceByBookingNo(env, no) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE booking_no = ?`).bind(no).first();
}

export function getInvoiceById(env, id) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(id).first();
}

export async function listInvoices(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, booking_no, token, status, client_name, event_type, venue_space, booking_date,
            grand_total, deposit_amount, payment_status, cleaning_fee_status, deposit_status, signed_at, created_at
     FROM invoices ORDER BY id DESC`
  ).all();
  return results;
}

export async function getPayments(env, invoiceId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_on ASC, id ASC`
  ).bind(invoiceId).all();
  return results;
}

export async function markSigned(env, id, { signature_png, signer_name }) {
  await env.DB.prepare(
    `UPDATE invoices
     SET status='signed', signature_png=?, signer_name=?, signed_at=datetime('now'), updated_at=datetime('now')
     WHERE id=?`
  ).bind(signature_png, signer_name, id).run();
}

// AGR + INV — filed once at signing, frozen thereafter (never refiled by a payment
// event). See setSecurityDepositFileId/setRentalReceiptFileId below for the two
// documents that DO change after signing.
export async function setDriveFileIds(env, id, { agreement, rentalInvoice }) {
  await env.DB.prepare(
    `UPDATE invoices
     SET drive_agreement_file_id = COALESCE(?, drive_agreement_file_id),
         drive_rental_invoice_file_id = COALESCE(?, drive_rental_invoice_file_id),
         updated_at = datetime('now')
     WHERE id=?`
  ).bind(agreement ?? null, rentalInvoice ?? null, id).run();
}

// RRC — filed once, the first time rental payment is confirmed (Addendum 3).
export async function setRentalReceiptFileId(env, id, fileId) {
  await env.DB.prepare(
    `UPDATE invoices SET drive_rental_receipt_file_id = ?, updated_at = datetime('now') WHERE id=?`
  ).bind(fileId, id).run();
}

// SD — Addendum 6: ONE evolving document. Called both at signing (initial unpaid
// bill) and again every time it's re-filed as payment status changes; always the
// same Drive file id gets overwritten in place (see drive.js's fileToDrive), so this
// setter just needs to run after every filing, not only the first.
export async function setSecurityDepositFileId(env, id, fileId) {
  await env.DB.prepare(
    `UPDATE invoices SET drive_security_deposit_file_id = ?, updated_at = datetime('now') WHERE id=?`
  ).bind(fileId, id).run();
}

// Sets a payment-event timestamp column ONLY if it isn't already set — re-applying
// the same Telegram command (e.g. "rental paid" twice) should not move the date a
// second time. `column` is a fixed internal name, never user input, so this is safe
// to interpolate directly.
const TIMESTAMP_COLUMNS = new Set([
  "sent_at", "rental_paid_at", "deposit_paid_at", "deposit_refunded_at",
  "unsigned_reminder_sent_at", "deposit_reminder_sent_at", "refund_reminder_sent_at",
]);
export async function markTimestampOnce(env, id, column) {
  if (!TIMESTAMP_COLUMNS.has(column)) throw new Error("Unknown timestamp column: " + column);
  await env.DB.prepare(
    `UPDATE invoices SET ${column} = COALESCE(${column}, datetime('now')), updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
}

export async function addPayment(env, invoiceId, { amount, kind, paid_on, note, payment_mode, bank, reference }) {
  await env.DB.prepare(
    `INSERT INTO payments (invoice_id, amount, kind, paid_on, note, payment_mode, bank, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(invoiceId, amount, kind, paid_on, note || null, payment_mode || null, bank || null, reference || null).run();
}

export async function setStatus(env, id, { payment_status, cleaning_fee_status, deposit_status }) {
  await env.DB.prepare(
    `UPDATE invoices
     SET payment_status = COALESCE(?, payment_status),
         cleaning_fee_status = COALESCE(?, cleaning_fee_status),
         deposit_status = COALESCE(?, deposit_status),
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(payment_status ?? null, cleaning_fee_status ?? null, deposit_status ?? null, id).run();
}

export async function voidInvoice(env, id) {
  await env.DB.prepare(`UPDATE invoices SET status='void', updated_at=datetime('now') WHERE id=?`)
    .bind(id).run();
}

// Refund proof screenshot (Addendum 4) — filed once, whichever refund path led here.
export async function setRefundProofFileId(env, id, fileId) {
  await env.DB.prepare(
    `UPDATE invoices SET drive_refund_proof_file_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(fileId, id).run();
}

// Booking folder id (Addendum 5) — cached after first creation so repeated filing
// doesn't re-search Drive by name every time.
export async function setBookingFolderId(env, id, folderId) {
  await env.DB.prepare(
    `UPDATE invoices SET drive_booking_folder_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(folderId, id).run();
}

// Postponement (Addendum 5) — price stays locked, this only moves the date. The
// caller (worker.js) is responsible for also moving the Drive folder if the month
// changed.
export async function updateBookingDate(env, id, newDate) {
  await env.DB.prepare(
    `UPDATE invoices SET booking_date = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newDate, id).run();
}

// ---------------------------------------------------------------------------
// Security deposit deductions (Addendum 4) — see schema.sql for why this is its
// own table rather than columns on invoices (a booking can have more than one).
// ---------------------------------------------------------------------------
export async function createDeduction(env, invoiceId, { amount, reason }) {
  const token = randomToken();
  const { meta } = await env.DB.prepare(
    `INSERT INTO deductions (invoice_id, token, amount, reason) VALUES (?, ?, ?, ?)`
  ).bind(invoiceId, token, amount, reason).run();
  return env.DB.prepare(`SELECT * FROM deductions WHERE id = ?`).bind(meta.last_row_id).first();
}

export function getDeductionByToken(env, token) {
  return env.DB.prepare(`SELECT * FROM deductions WHERE token = ?`).bind(token).first();
}

export async function listDeductionsForInvoice(env, invoiceId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM deductions WHERE invoice_id = ? ORDER BY id ASC`
  ).bind(invoiceId).all();
  return results;
}

export async function acknowledgeDeduction(env, id, { signature_png, acknowledger_name }) {
  await env.DB.prepare(
    `UPDATE deductions
     SET status = 'acknowledged', signature_png = ?, acknowledger_name = ?, acknowledged_at = datetime('now')
     WHERE id = ?`
  ).bind(signature_png, acknowledger_name, id).run();
}

export async function setDeductionDriveFileId(env, id, fileId) {
  await env.DB.prepare(`UPDATE deductions SET drive_file_id = ? WHERE id = ?`).bind(fileId, id).run();
}

export async function markDeductionReminderSent(env, id) {
  await env.DB.prepare(
    `UPDATE deductions SET reminder_sent_at = COALESCE(reminder_sent_at, datetime('now')) WHERE id = ?`
  ).bind(id).run();
}

// ---------------------------------------------------------------------------
// Daily reminder queries (Addendum 3) — each returns bookings that need a
// one-time nag; the caller marks the corresponding *_reminder_sent_at column
// (via markTimestampOnce) right after sending so the same booking isn't
// re-reported on the next day's cron run.
// ---------------------------------------------------------------------------

// Sent to the client (sent_at set) 3+ days ago, still not signed, never reminded.
export async function listUnsignedNeedingReminder(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM invoices
     WHERE status = 'issued'
       AND sent_at IS NOT NULL
       AND unsigned_reminder_sent_at IS NULL
       AND datetime(sent_at) <= datetime('now', '-3 days')`
  ).all();
  return results;
}

// Signed, event is within the next 7 days, deposit still not collected, never reminded.
export async function listDepositsDueNeedingReminder(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM invoices
     WHERE status = 'signed'
       AND deposit_status = 'Not Collected'
       AND deposit_reminder_sent_at IS NULL
       AND date(booking_date) <= date('now', '+7 days')
       AND date(booking_date) >= date('now')`
  ).all();
  return results;
}

// Event already happened, deposit still held (not refunded), no deduction ever
// filed for it (a deduction in progress is a different situation — see
// listDeductionsNeedingBalanceReminder below), never reminded. The actual
// "4+ working days" threshold (Clause 8.1's 5-7 day promise) is checked by the
// caller — SQLite has no clean working-day arithmetic, so this returns candidates
// by calendar date and the caller filters with pricing.js-style Mon-Fri counting.
export async function listUnrefundedPastEvent(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM invoices i
     WHERE i.status = 'signed'
       AND i.deposit_status = 'Held'
       AND i.refund_reminder_sent_at IS NULL
       AND date(i.booking_date) < date('now')
       AND NOT EXISTS (SELECT 1 FROM deductions d WHERE d.invoice_id = i.id)`
  ).all();
  return results;
}

// Deduction acknowledged, balance not yet paid out, never reminded. Same
// caller-side working-day filtering as listUnrefundedPastEvent above (Clause 8.4's
// 3-working-day promise, timed from acknowledged_at not the event date).
export async function listDeductionsNeedingBalanceReminder(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, i.booking_no, i.client_name, i.deposit_status, i.token
     FROM deductions d
     JOIN invoices i ON i.id = d.invoice_id
     WHERE d.status = 'acknowledged'
       AND d.reminder_sent_at IS NULL
       AND i.deposit_status != 'Refunded'`
  ).all();
  return results;
}

// ---------------------------------------------------------------------------
// Promo presets
// ---------------------------------------------------------------------------
export async function listActivePromos(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM promos WHERE active = 1`).all();
  return results;
}

export async function listAllPromos(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM promos ORDER BY id DESC`).all();
  return results;
}

export async function createPromo(env, p) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO promos
       (name, active, valid_from, valid_to, discount_percent, cleaning_fee_override,
        extra_discount_hours_threshold, extra_discount_amount, rental_fee_note, cleaning_fee_note,
        clause_title, clause_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      p.name, p.active ?? 1, p.valid_from, p.valid_to,
      p.discount_percent || 0, p.cleaning_fee_override ?? null,
      p.extra_discount_hours_threshold ?? null, p.extra_discount_amount || 0,
      p.rental_fee_note || null, p.cleaning_fee_note || null,
      p.clause_title || null, p.clause_text || null
    )
    .run();
  return env.DB.prepare(`SELECT * FROM promos WHERE id = ?`).bind(meta.last_row_id).first();
}

export async function setPromoActive(env, id, active) {
  await env.DB.prepare(`UPDATE promos SET active = ? WHERE id = ?`).bind(active ? 1 : 0, id).run();
}

// ---------------------------------------------------------------------------
// Pending bookings — staging for the Telegram "confirm before creating" flow.
// ---------------------------------------------------------------------------
export async function createPendingBooking(env, chatId, data) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO pending_bookings (chat_id, data) VALUES (?, ?)`
  ).bind(String(chatId), JSON.stringify(data)).run();
  return meta.last_row_id;
}

export async function getPendingBooking(env, id) {
  const row = await env.DB.prepare(`SELECT * FROM pending_bookings WHERE id = ?`).bind(id).first();
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export async function deletePendingBooking(env, id) {
  await env.DB.prepare(`DELETE FROM pending_bookings WHERE id = ?`).bind(id).run();
}

// ---------------------------------------------------------------------------
// Addendum 7 — WhatsApp-quote-template accumulation (see schema.sql). One row
// per chat_id; each of the 3 field groups is NULL until that message type has
// arrived, parsed as JSON once it has.
// ---------------------------------------------------------------------------
export async function getPendingWaAccumulation(env, chatId) {
  const row = await env.DB.prepare(`SELECT * FROM pending_wa_accumulation WHERE chat_id = ?`).bind(String(chatId)).first();
  if (!row) return null;
  return {
    ...row,
    event_details: row.event_details ? JSON.parse(row.event_details) : null,
    quote: row.quote ? JSON.parse(row.quote) : null,
    particulars: row.particulars ? JSON.parse(row.particulars) : null,
  };
}

// Merges `fields` into whichever single group (`"event_details" | "quote" |
// "particulars"`) just arrived — the other two groups are left untouched via
// COALESCE against the existing row (or NULL, on first insert for this chat).
export async function setPendingWaGroup(env, chatId, group, fields) {
  const col = { event_details: "event_details", quote: "quote", particulars: "particulars" }[group];
  if (!col) throw new Error("Unknown WA accumulation group: " + group);
  await env.DB.prepare(
    `INSERT INTO pending_wa_accumulation (chat_id, ${col}, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = datetime('now')`
  ).bind(String(chatId), JSON.stringify(fields)).run();
}

// Starts a fresh accumulation for this chat, discarding anything in flight — used
// when a NEW Event-details message arrives (the natural "start of a new booking"
// signal, since it's always the first of the three Kenneth sends).
export async function resetPendingWaAccumulation(env, chatId, group, fields) {
  const col = { event_details: "event_details", quote: "quote", particulars: "particulars" }[group];
  if (!col) throw new Error("Unknown WA accumulation group: " + group);
  await env.DB.prepare(
    `INSERT INTO pending_wa_accumulation (chat_id, ${col}, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET event_details = NULL, quote = NULL, particulars = NULL, ${col} = excluded.${col}, updated_at = datetime('now')`
  ).bind(String(chatId), JSON.stringify(fields)).run();
}

export async function clearPendingWaAccumulation(env, chatId) {
  await env.DB.prepare(`DELETE FROM pending_wa_accumulation WHERE chat_id = ?`).bind(String(chatId)).run();
}

// ---------------------------------------------------------------------------
// Addendum 7 — pending payment-match actions (see schema.sql). Same small-
// integer-id round-trip pattern as pending_bookings.
// ---------------------------------------------------------------------------
export async function createPendingPaymentAction(env, chatId, invoiceId, { amount, matched_kind, payment_mode, bank, reference }) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO pending_payment_actions (chat_id, invoice_id, amount, matched_kind, payment_mode, bank, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(chatId), invoiceId, amount, matched_kind, payment_mode || null, bank || null, reference || null).run();
  return meta.last_row_id;
}

export function getPendingPaymentAction(env, id) {
  return env.DB.prepare(`SELECT * FROM pending_payment_actions WHERE id = ?`).bind(id).first();
}

export async function deletePendingPaymentAction(env, id) {
  await env.DB.prepare(`DELETE FROM pending_payment_actions WHERE id = ?`).bind(id).run();
}

// ---------------------------------------------------------------------------
// Addendum 7 — editable WhatsApp message templates.
// ---------------------------------------------------------------------------
export async function getMessageTemplate(env, key) {
  const row = await env.DB.prepare(`SELECT body FROM message_templates WHERE key = ?`).bind(key).first();
  return row ? row.body : null;
}

export async function setMessageTemplate(env, key, body) {
  await env.DB.prepare(
    `INSERT INTO message_templates (key, body, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`
  ).bind(key, body).run();
}

export async function listMessageTemplates(env) {
  const { results } = await env.DB.prepare(`SELECT key, body FROM message_templates ORDER BY key`).all();
  return results;
}
