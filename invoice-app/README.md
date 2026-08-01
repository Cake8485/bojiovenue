# BojioVenue — Invoice / Receipt Generator (+ Agreement Generator)

Custom, self-hosted invoice/receipt system for BojioVenue, replacing Zoho.
Runs on a Cloudflare Worker with a D1 database. **$0 recurring cost.**

- You create a booking via the **admin page** or by **messaging the Telegram bot** a
  fixed template.
- Client opens a link → reads and signs the **Agreement** in-browser → 3 PDFs are
  generated server-side (signed Agreement, Booking Invoice, Deposit Invoice) and
  filed automatically into the correct Google Drive month folder.
- Nothing ever sits as a file on your phone.

---

## How it works (architecture)

```
You                                Cloudflare Worker                    Google
  /admin  ──create invoice──▶   assigns a booking number (e.g. 2026036), random token
  OR message the Telegram bot   store in D1 ─────────────────────────────────
  a fixed template ───────────▶

Client browser
  /sign/:token ──review──▶      returns agreement + booking data
  sign on canvas ──submit──▶    build 3 PDFs (pdf-lib):
                                  AGR (signed Agreement), INV (Rental Invoice), SD (Security Deposit)
                               upload all 3 ───────────────────▶  Drive /2026-07/2026036_ClientName_12Jul/
                               notify ─────────────────────────▶  Telegram (you)
```
A 4th document, RRC (rental receipt), is generated the first time rental payment is
confirmed — see "Numbering & documents" below.

**Why a database (D1)?** The "no-gaps booking number" requirement can't be done safely
with a plain counter on stateless Workers. D1 (Cloudflare's built-in SQLite, free tier)
gives an atomic gapless sequence *and* stores invoices + the payment log. See
`src/db.js` for the gapless-numbering trick.

### Dependencies (deliberately minimal)
| What | Where | Why |
|---|---|---|
| `pdf-lib` | bundled into Worker | Generate the PDF server-side. Pure JS, no native deps, MIT. |
| `wrangler` | dev only | Cloudflare's CLI to run/deploy the Worker. |
| Signature capture | hand-written in `pages.js` | ~40 lines of canvas code, so **no** `signature_pad` dependency. Swappable later if you want fancier smoothing. |
| Google Drive / Telegram | plain `fetch()` | No SDKs. |

### File map
```
wrangler.toml        Worker + D1 config, non-secret vars
schema.sql           D1 tables (invoices, payments, deductions, promos, pending_bookings, booking_no_seed)
package.json         scripts + deps
.dev.vars.example    template for local secrets  (copy to .dev.vars)
src/worker.js        router + request handlers (this is most of the app's logic)
src/db.js            all SQL (incl. gapless per-year booking-number numbering)
src/pricing.js       venue pricing rules  ⚠ has flagged open questions
src/agreement.js     Agreement content (2 templates, picked by venue_space) + PDF builder
src/deductions.js    Security Deposit Deduction Addendum content + PDF builder
src/branding.js      shared PDF primitives for the Agreement/Deduction Addendum identity (blue/yellow/purple)
src/pdf.js           Rental Invoice (INV) + Security Deposit doc (SD) builders — the "money document" identity
src/receipts.js      Rental Receipt (RRC) builder — shares content logic with pdf.js
src/brandingMoney.js shared PDF primitives for the money-document identity (lavender/purple, Zoho-matched)
src/paynow.js         PayNow SGQR payload + QR rendering (SVG + pdf-lib vector)
src/drive.js          Google Drive upload (OAuth refresh + multipart) + folder management
src/notify.js         Telegram notifications (outbound) + reply helper (inbound bot replies)
src/pages.js          admin UI + client signing page + deduction acknowledgment page
src/assets.js         bundled binary assets (fonts, logo, mascot watermark)
```

### Creating a booking via Telegram

Message your bot (`@BojioVenueInvoiceBot`) this exact format — only messages from
your own Telegram account are accepted, everyone else is silently ignored:

```
Name: Jane Tan
NRIC/UEN: S1234567A
Event Type: Social
Venue: Whole Venue
Date of Event: 2026-08-15
Time Start: 14:00
Duration: 8
Purpose: Birthday party
Rate: 150
Discount: 10
Cleaning With: Deposit
Other: 
```

- **Event Type**: Social, Corporate, or Seminar. **Venue**: Whole Venue or Main Hall Only.
- **Date must be YYYY-MM-DD** — any other format is rejected with an error, on purpose
  (ambiguous dates like 08/09 are a classic source of wrong invoices).
- **Rate**/**Discount** (Social only): package $/hr rate and a plain discount % — blank
  Rate = usual weekday/weekend rate, blank Discount = none (a promo may suggest both).
- **Cleaning With**: `Rental` or `Deposit` — which payment the cleaning fee is billed
  with (blank defaults to Deposit).
- **Other** (Corporate/Seminar only) is a free-text discount, optional (blank = no
  discount). Recognized: `10% off`, `$50 off`, `-$30`. Anything it can't confidently
  parse is left at $0 and saved as a note for you to fix in admin — it will never
  silently apply a wrong discount to a real invoice.
- The bot replies with the computed price and a signing link to forward to the client
  (e.g. via WhatsApp).
- **Registering the webhook** (one-time, after deploying): `setWebhook` must be called
  with your live Worker URL — this can't be tested against `localhost`, only done once
  deployed. Claude will walk you through this at deploy time.

---

## Setup (one-time)

> You need Node.js installed. Everything else is walked through with you.

```bash
cd bojiovenue
npm install

# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
npm run db:create

# 2. Create the tables
npm run db:init          # remote (production DB)
npm run db:init:local    # local dev DB

# 3. Set secrets (production). You'll get these values during the guided steps.
npx wrangler secret put ADMIN_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# 4. Run locally (uses .dev.vars for secrets)
npm run dev

# 5. Deploy
npm run deploy
```

After first deploy, set `PUBLIC_BASE_URL` in `wrangler.toml` to your real Worker URL and
`DRIVE_PARENT_FOLDER_ID` to the Drive folder chosen during OAuth setup, then deploy again.

**Google OAuth + Telegram setup are guided step-by-step by Claude** — not written out here
because they involve clicking through Google's console and Telegram; we'll do them live.

---

## Decisions locked (Section 9 + design)

| Topic | Decision |
|---|---|
| Google account | Personal gmail → OAuth **published to Production** (avoids 7-day token death) |
| Drive filing | Month folder `YYYY-MM` → one subfolder per booking `{booking_no}_{ClientName}_{DDMon}`, both auto-created, based on **booking (event) date** |
| File naming | Just the document's own number: `AGR-2026036.pdf`, `INV-2026036.pdf`, `RRC-2026036.pdf`, `SD-2026036.pdf`, `DDA-2026036.pdf` (the folder already carries client/date context) |
| Client info | Fresh entry each time (no stored customer list) |
| Payments | Dated payment **log** (with optional mode/bank/reference) + three status fields (rental, cleaning fee, deposit) |
| Numbering | One gapless **booking number** per booking, `{year}{seq, zero-padded 3}` e.g. `2026036`, year-scoped and reset each year; cancellations → **Void** record, number kept. Every document derives its display number by prefixing this — see "Numbering & documents" below. |
| Notification | Telegram (swappable to email later) |
| PDF | Built **server-side** (tamper-proof) |
| Signing link | Unguessable random token per invoice |
| Deposit | **Separate refundable security deposit** — never netted against the rental balance owed |
| Pricing engine | **event_type picks the engine** — Social vs Corporate/Seminar price completely differently. See Pricing below. |
| Documents | Client signs the **Agreement** (not a bare invoice). Two visual identities: Agreement + Deduction Addendum (blue/yellow/purple) vs money documents — Rental Invoice, Rental Receipt, Security Deposit doc (lavender/purple, Zoho-matched). See "Numbering & documents" below. |

### Numbering & documents (Addendum 6)

One **booking number** per booking (`invoices.booking_no`, e.g. `2026036`) is assigned
gapless-per-year on creation. Every document derives its own display number by
prefixing it — computed at render/filename time, never stored separately:

| Prefix | Document | Lifecycle |
|---|---|---|
| `AGR` | Agreement (signed) | Filed once at signing, frozen |
| `INV` | Rental Invoice (bill) | Filed at signing; refiled in place if rental-side status changes before it's paid |
| `RRC` | Rental Receipt | Filed **once**, the first time rental payment is confirmed |
| `SD` | Security Deposit doc | Filed at signing (unpaid) and **refiled in place** (same file) as deposit/cleaning-fee status changes — no separate "receipt" ever exists for this side |
| `DDA` | Deduction Addendum | Filed once acknowledged; `-2`, `-3`… suffix if a booking has more than one |

The cleaning fee is billed on whichever of INV/RRC or SD matches that booking's
`cleaning_fee_with` ('rental' or 'deposit', default 'deposit') — set via the Telegram
template's `Cleaning With:` field or the admin form.

Telegram status commands accept the bare booking number ("2026036 rental paid") or any
prefixed document number ("RRC-2026036 paid paynow ocbc ref 123") — whichever you're
looking at — see `BOOKING_REF_RE` in `src/worker.js`.
| Agreement template | Picked by **venue_space**: Whole Venue → general/Novan Management agreement; Main Hall Only → Seminar/Training Room agreement |
| Booking creation | Via `/admin`, **or** by messaging the Telegram bot a fixed template (restricted to Kenneth's chat_id only) |
| Discounts | Optional free-text field ("10% off", "$50 off"), parsed to a flat $ amount; unparseable text is never silently applied |

---

## Pricing (confirmed 2026-07-20, sourced live from bojiovenue.com — supersedes the 07-12 version)

Two unrelated pricing engines, selected by `event_type`:

**Social** — always Whole Venue (no Main Hall option exists for Social). Priced from a fixed
**package-deal table**, NOT hours × a flat rate:
- Mon–Thu: 4h=$520 … 8h=$800🔥 … 12h=$1200 (declining effective rate, $100/hr floor)
- Fri–Sun & PH: 4h=$640 … 8h=$1200🔥 … 12h=$1680 ($140/hr floor)
- <4h or a same-day extension: plain $150/hr (weekday) or $180/hr (weekend)
- Deposit $500, cleaning fee $80 — always

**Corporate / Seminar** — share the same engine (confirmed: Seminar/Workshop uses Corporate's
rates, since the site has no separate Seminar card). Genuine hours × rate, but the rate depends
on committing to a **minimum number of hours**:
- Whole Venue Mon–Thu: min 15h @ $90/hr, or min 25h @ $70/hr
- Whole Venue Fri–Sun: min 15h @ $120/hr, or min 25h @ $100/hr
- Main Hall Only Mon–Thu: min 10h @ $70/hr, or min 20h @ $55/hr — **no weekend version exists**
- Below the minimum: flat $90/hr fallback
- Deposit $200, cleaning fee $50 — flat, regardless of which venue space

Plus: optional **Pet Cleaning Fee** ($100, checkbox on the invoice form, added on top).

**"Small Training Room"** (mentioned in an old agreement PDF) is confirmed dropped — only
Whole Venue and Main Hall Only exist now.

**Known small gaps, flagged not blocking:**
- `isWeekend()` currently only treats Sat/Sun as weekend — the site's real boundary is
  "Fri–Sun & PH" for Social (Friday counts, and PH doesn't shift it for Corporate). Friday
  and public-holiday handling isn't implemented yet.
- Pricing beyond 12h for Social isn't on the published rate card — currently extrapolated
  at the 12h package's effective $/hr as a reasonable default, not an official rate.
- All of the above can always be overridden manually per invoice (the admin form's
  hourly_rate/cleaning_fee/deposit_amount fields accept manual entry).

---

## ⚠ Open questions still needing your input

1. **Admin protection.** `/admin` is currently gated by a shared `ADMIN_KEY`. For a stronger
   free option I recommend **Cloudflare Access** (Zero Trust, free ≤50 users) so you log in
   with Google. Want that instead of / in addition to the key?
2. **Agreement text accuracy.** `src/agreement.js` was transcribed from your two real signed
   agreement PDFs (2026-07-12) — worth a careful read-through once deployed, since it's a
   legal document and I may have missed a nuance in translating PDF layout to plain text.

---

## Status
Google Drive + Telegram integrations, the full pricing engine, the Agreement Generator
(2 real templates), the 3-document signing flow, and Telegram-based booking creation are
all **built and verified working end-to-end** on real infrastructure — tested via real API
calls, a real simulated Telegram webhook payload, and by downloading + reading the actual
generated PDFs from Drive, not just trusting success responses.

**Not yet deployed to production** — secrets currently only exist in local `.dev.vars`.
Remaining before going live:
1. `wrangler secret put` × 6 on the real Worker
2. `wrangler deploy`
3. Attach the `invoice.bojiovenue.com` custom domain
4. Register the Telegram webhook (`setWebhook`) against the live URL — can't be done until deployed
5. The open questions above
