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
        hourly_rate, cleaning_fee, deposit_amount, pet_fee, discount, discount_note, rental_total, grand_total, notes)
     SELECT n,
            'INV-' || printf('%03d', n),
            ?, 'issued',
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM invoices)`
  )
    .bind(
      token,
      d.client_name, d.client_phone, d.client_email, d.client_nric_uen,
      d.event_type, d.venue_space, d.booking_date, d.start_time, d.end_time, d.hours,
      d.hourly_rate, d.cleaning_fee, d.deposit_amount, d.pet_fee, d.discount, d.discount_note, d.rental_total, d.grand_total, d.notes
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
