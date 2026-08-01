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

// Downloads the actual bytes of an inbound Telegram photo (Addendum 4 — Kenneth
// forwards his bank transfer screenshot for a refund payout). Telegram's `photo`
// field on a message is an array of the same image at different resolutions; the
// caller should pass the LARGEST one's file_id (last in the array) for the best
// quality. Two-step API: getFile resolves file_id -> file_path, then the file
// itself is served from a *different* (non-`/bot`) URL prefix.
export async function getTelegramPhotoBytes(env, fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) throw new Error("Telegram getFile failed: " + (await infoRes.text()));
  const info = await infoRes.json();
  const filePath = info.result && info.result.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");
  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error("Telegram file download failed: " + (await fileRes.text()));
  return new Uint8Array(await fileRes.arrayBuffer());
}
