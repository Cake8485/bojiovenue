// Google Drive upload via the REST API — no SDK, just fetch().
//
// Auth model: a long-lived OAuth *refresh token* (yours) is stored as a Worker secret.
// On each upload we exchange it for a short-lived access token. Files are owned by you.
//
// Folder structure (rewritten Addendum 5, 2026-08-01): DRIVE_PARENT_FOLDER_ID ->
// month folder (by event date, e.g. "2026-08") -> one subfolder per booking (e.g.
// "INV-003_Nirmala_08Aug") -> every document for that booking lives inside. Two
// levels of the SAME "find by name under this parent, or create" logic — see
// ensureSubfolder below, used for both levels.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

export async function getAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Google token refresh failed: " + (await res.text()));
  return (await res.json()).access_token;
}

// Find (or create) a folder by name directly under `parentId`. Used for both the
// month level and, nested inside a month folder, the per-booking level.
export async function ensureSubfolder(accessToken, parentId, name) {
  const q =
    `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and ` +
    `mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await fetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (data.files && data.files.length) return data.files[0].id;

  const create = await fetch(FILES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!create.ok) throw new Error("Create folder failed: " + (await create.text()));
  return (await create.json()).id;
}

// Back-compat name for the month-level call specifically (reads clearer at call
// sites than the generic ensureSubfolder).
export function ensureMonthFolder(accessToken, parentId, monthName) {
  return ensureSubfolder(accessToken, parentId, monthName);
}

// Resolves (creating if needed) the full month -> booking folder path in one call,
// returning the booking folder's ID plus the access token used (so a caller that
// needs to do more Drive work right after — like moveFolder — doesn't have to
// fetch a fresh one). Callers should cache the returned folder ID (see
// db.setBookingFolderId) rather than calling this on every single file operation.
export async function ensureBookingFolder(env, monthName, bookingFolderName) {
  const accessToken = await getAccessToken(env);
  const monthFolderId = await ensureSubfolder(accessToken, env.DRIVE_PARENT_FOLDER_ID, monthName);
  const folderId = await ensureSubfolder(accessToken, monthFolderId, bookingFolderName);
  return { accessToken, monthFolderId, folderId };
}

// Renames a folder in place (id and contents unchanged) — used by the postpone
// command so a booking folder's {DDMon} suffix stays accurate even when the date
// change doesn't cross a month boundary (no move needed, but the name is still stale).
export async function renameFolder(env, folderId, newName) {
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${FILES_URL}/${folderId}?fields=id,name`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) throw new Error("Drive folder rename failed: " + (await res.text()));
  return res.json();
}

// Moves a folder (and everything inside it) from one parent to another — used when
// a booking is postponed into a different month. Drive files/folders reference
// their parent(s) directly, so moving the booking folder automatically moves every
// document already filed inside it; nothing else needs to change.
export async function moveFolder(env, folderId, oldParentId, newParentId) {
  const accessToken = await getAccessToken(env);
  const res = await fetch(
    `${FILES_URL}/${folderId}?addParents=${newParentId}&removeParents=${oldParentId}&fields=id,parents`,
    { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error("Drive folder move failed: " + (await res.text()));
  return res.json();
}

async function findFileInFolder(accessToken, folderId, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`;
  const res = await fetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

function multipartBody(boundary, metadata, bytes, mimeType) {
  const enc = new TextEncoder();
  const pre = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const post = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(pre.length + bytes.length + post.length);
  out.set(pre, 0);
  out.set(bytes, pre.length);
  out.set(post, pre.length + bytes.length);
  return out;
}

async function createFile(accessToken, folderId, filename, bytes, mimeType) {
  const boundary = "bojio" + crypto.randomUUID().replace(/-/g, "");
  const body = multipartBody(boundary, { name: filename, parents: [folderId] }, bytes, mimeType);
  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error("Drive upload failed: " + (await res.text()));
  return res.json();
}

async function replaceMedia(accessToken, fileId, bytes, mimeType) {
  const res = await fetch(
    `${UPLOAD_URL}/${fileId}?uploadType=media&fields=id,name,webViewLink`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": mimeType },
      body: bytes,
    }
  );
  if (!res.ok) throw new Error("Drive replace failed: " + (await res.text()));
  return res.json();
}

// Upload a file into an already-resolved folder (see ensureBookingFolder). If a
// file with the same name already exists (e.g. re-filing after a status change, or
// Kenneth re-sending a refund screenshot), its contents are replaced in place so
// the filed document always reflects the latest version — no duplicates. `mimeType`
// defaults to PDF since that's still almost every caller; refund-proof screenshots
// pass "image/jpeg".
export async function fileToDrive(env, { folderId, filename, pdfBytes, mimeType }) {
  const accessToken = await getAccessToken(env);
  const existing = await findFileInFolder(accessToken, folderId, filename);
  const type = mimeType || "application/pdf";
  return existing
    ? replaceMedia(accessToken, existing, pdfBytes, type)
    : createFile(accessToken, folderId, filename, pdfBytes, type);
}
