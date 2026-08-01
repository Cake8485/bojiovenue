// D1 data access. All SQL lives here.
//
// GAPLESS NUMBERING (the tricky requirement):
// The invoice number is derived INSIDE a single INSERT statement:
//     seq = (SELECT COALESCE(MAX(seq),0)+1 FROM invoices)
// Because D1 serialises writes to the database, this is atomic: either the row is
// inserted with the next number, or nothing is inserted (no gap is ever burned by a
// failed insert). Cancelled bookings become status='void' records that KEEP their
// number, so the sequence stays gapless with a full audit trail.

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
       (seq, invoice_no, token, status,
        client_name, client_phone, client_email, client_nric_uen,
        event_type, venue_space, booking_date, start_time, end_time, hours,
        usual_rate, hourly_rate, rental_subtotal, discount_percent,
        cleaning_fee, deposit_amount, pet_fee, discount, discount_note, rental_total, grand_total,
        rental_fee_note, cleaning_fee_note, deposit_note, pet_fee_note, promo_clause_title, promo_clause_text, promo_id, notes)
     SELECT n,
            'INV-' || printf('%03d', n),
            ?, 'issued',
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
     FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM invoices)`
  )
    .bind(
      token,
      d.client_name, d.client_phone, d.client_email, d.client_nric_uen,
      d.event_type, d.venue_space, d.booking_date, d.start_time, d.end_time, d.hours,
      d.usual_rate ?? null, d.hourly_rate, d.rental_subtotal ?? null, d.discount_percent || 0,
      d.cleaning_fee, d.deposit_amount, d.pet_fee, d.discount, d.discount_note, d.rental_total, d.grand_total,
      d.rental_fee_note || null, d.cleaning_fee_note || null, d.deposit_note || null, d.pet_fee_note || null,
      d.promo_clause_title || null, d.promo_clause_text || null, d.promo_id || null, d.notes
    )
    .run();
  return getInvoiceByToken(env, token);
}

export function getInvoiceByToken(env, token) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE token = ?`).bind(token).first();
}

export function getInvoiceByNo(env, no) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE invoice_no = ?`).bind(no).first();
}

export function getInvoiceById(env, id) {
  return env.DB.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(id).first();
}

export async function listInvoices(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, seq, invoice_no, token, status, client_name, event_type, venue_space, booking_date,
            grand_total, deposit_amount, payment_status, cleaning_fee_status, deposit_status, signed_at, created_at
     FROM invoices ORDER BY seq DESC`
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

export async function setDriveFileIds(env, id, { agreement, bookingInvoice, depositInvoice }) {
  await env.DB.prepare(
    `UPDATE invoices
     SET drive_agreement_file_id = COALESCE(?, drive_agreement_file_id),
         drive_booking_invoice_file_id = COALESCE(?, drive_booking_invoice_file_id),
         drive_deposit_invoice_file_id = COALESCE(?, drive_deposit_invoice_file_id),
         updated_at = datetime('now')
     WHERE id=?`
  ).bind(agreement ?? null, bookingInvoice ?? null, depositInvoice ?? null, id).run();
}

// Receipts (Addendum 3) — distinct from the invoice Drive file ids above.
export async function setReceiptFileIds(env, id, { rentalReceipt, depositReceipt }) {
  await env.DB.prepare(
    `UPDATE invoices
     SET drive_rental_receipt_file_id = COALESCE(?, drive_rental_receipt_file_id),
         drive_deposit_receipt_file_id = COALESCE(?, drive_deposit_receipt_file_id),
         updated_at = datetime('now')
     WHERE id=?`
  ).bind(rentalReceipt ?? null, depositReceipt ?? null, id).run();
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

export async function addPayment(env, invoiceId, { amount, kind, paid_on, note }) {
  await env.DB.prepare(
    `INSERT INTO payments (invoice_id, amount, kind, paid_on, note) VALUES (?, ?, ?, ?, ?)`
  ).bind(invoiceId, amount, kind, paid_on, note || null).run();
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
    `SELECT d.*, i.invoice_no, i.client_name, i.deposit_status, i.token
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
