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

// `buttons`: optional array of rows, each row an array of {text, callback_data}
// (Telegram's inline-keyboard shape) — used for the Telegram-as-admin-interface
// confirm/send/preview/edit flow in worker.js.
export async function sendTelegram(env, chatId, text, buttons) {
  const body = { chat_id: chatId, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.log("[notify] Telegram failed: " + (await res.text()));
  return res;
}

// Acknowledges a button press — Telegram shows a loading spinner on the tapped
// button until this is called, regardless of what (if anything) else is sent back.
export async function answerCallbackQuery(env, callbackQueryId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined }),
  });
  if (!res.ok) console.log("[notify] answerCallbackQuery failed: " + (await res.text()));
}

// Sends a PDF (or any file) as a Telegram document attachment — used for the
// "Preview agreement" button, so Kenneth sees the exact PDF the client will see.
export async function sendTelegramDocument(env, chatId, filename, pdfBytes, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([pdfBytes], { type: "application/pdf" }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) console.log("[notify] sendDocument failed: " + (await res.text()));
  return res;
}
