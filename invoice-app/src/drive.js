// Google Drive upload via the REST API — no SDK, just fetch().
//
// Auth model: a long-lived OAuth *refresh token* (yours) is stored as a Worker secret.
// On each upload we exchange it for a short-lived access token. Files are owned by you
// and land in the correct month folder under DRIVE_PARENT_FOLDER_ID.

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

// Find (or create) the `2026-07`-style folder under the configured parent.
export async function ensureMonthFolder(accessToken, parentId, monthName) {
  const q =
    `name='${monthName}' and '${parentId}' in parents and ` +
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
      name: monthName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!create.ok) throw new Error("Create month folder failed: " + (await create.text()));
  return (await create.json()).id;
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

// Upload a file into the month folder. If a file with the same name already exists
// (e.g. re-filing after a status change, or Kenneth re-sending a refund screenshot),
// its contents are replaced in place so the filed document always reflects the
// latest version — no duplicates. `mimeType` defaults to PDF since that's still
// almost every caller; Addendum 4's refund-proof screenshots pass "image/jpeg".
export async function fileToDrive(env, { monthName, filename, pdfBytes, mimeType }) {
  const accessToken = await getAccessToken(env);
  const folderId = await ensureMonthFolder(accessToken, env.DRIVE_PARENT_FOLDER_ID, monthName);
  const existing = await findFileInFolder(accessToken, folderId, filename);
  const type = mimeType || "application/pdf";
  return existing
    ? replaceMedia(accessToken, existing, pdfBytes, type)
    : createFile(accessToken, folderId, filename, pdfBytes, type);
}
