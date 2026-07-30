// Notifications. Currently Telegram (free, instant, no domain setup; also doubles as
// the inbound channel for creating invoices — see worker.js's /telegram/webhook).
// Written so a second channel (e.g. email via Resend) can be dropped in without
// touching callers.

// filed: { agreement, bookingInvoice, depositInvoice } — each either a Drive
// files.create response ({id, name, webViewLink}) or null if that document
// failed to file. Includes the actual clickable Drive link per document, per
// Kenneth's request, not just "which folder it's in."
export async function notifySigned(env, invoice, filed = {}) {
  const month = (invoice.booking_date || "").slice(0, 7);
  const docLine = (label, doc) =>
    doc ? `  • ${label}: ${doc.webViewLink}` : `  • ${label} — FAILED to file, retry from admin`;
  const filedLines = [
    docLine("Agreement", filed.agreement),
    docLine("Booking Invoice", filed.bookingInvoice),
    docLine("Deposit Invoice", filed.depositInvoice),
  ].join("\n");
  const text =
    `✅ ${invoice.invoice_no} signed by ${invoice.signer_name || invoice.client_name}\n` +
    `${invoice.event_type} event · ${invoice.venue_space} · ${invoice.booking_date}\n` +
    `Booking total: $${Number(invoice.grand_total || 0).toFixed(2)}   Deposit: $${Number(invoice.deposit_amount || 0).toFixed(2)}\n` +
    `Filed to Drive folder ${month}:\n${filedLines}`;
  await sendTelegramMessage(env, text);
}

export async function sendTelegramMessage(env, text) {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    return sendTelegram(env, env.TELEGRAM_CHAT_ID, text);
  }
  // No channel configured — notifications are optional, so just no-op.
  console.log("[notify] no channel configured; message was:\n" + text);
}

export async function sendTelegram(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) console.log("[notify] Telegram failed: " + (await res.text()));
  return res;
}
