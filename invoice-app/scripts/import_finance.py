#!/usr/bin/env python3
"""Load BoJioVenue's finance history into the dashboard's database.

WHY: the invoice app only holds bookings made since it went live. The real money
history lives in accounting.xlsx, expenses-2026.xlsx and the Lead Manager. This reads
those (read-only) and writes ONE SQL file for `wrangler d1 execute`.

PRIVACY: the output contains client names and amounts, and this GitHub repo is
PUBLIC. The default output folder `.seed/` is git-ignored — keep it that way, and
never commit the generated SQL.

SAFE TO RE-RUN: each import source is replaced wholesale (DELETE ... WHERE source =
'import:...' then INSERT), so re-running after Carine updates a workbook refreshes
the numbers instead of duplicating them. Rows typed into the dashboard
(source = 'manual') are never touched.

    python scripts/import_finance.py --root "G:/My Drive/LuFamily-HQ/04_BoJioVenue"
    npx wrangler d1 execute bojiovenue-invoice --local  --file=.seed/finance-import.sql
    npx wrangler d1 execute bojiovenue-invoice --remote --file=.seed/finance-import.sql
"""
import argparse, collections, json, re, sys
from datetime import datetime, date
from pathlib import Path

import openpyxl

CATEGORIES = ["Utilities", "Cleaning contractor", "Consumables & replacements",
              "Marketing / ad spend", "Platform commission", "Equipment (capex)", "Other"]


def sql(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, (datetime, date)): return "'%s'" % v.strftime("%Y-%m-%d")
    return "'%s'" % str(v).replace("\ufffd", "—").replace("'", "''")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")


def num(v):
    return float(v) if isinstance(v, (int, float)) else None


def iso(v):
    if isinstance(v, datetime): return v.strftime("%Y-%m-%d")
    if isinstance(v, date): return v.strftime("%Y-%m-%d")
    return None


def insert(table, cols, row):
    return "INSERT INTO %s (%s) VALUES (%s);" % (table, ", ".join(cols), ", ".join(sql(row[c]) for c in cols))


def import_bookings(wb, out, report):
    ws = wb["Bookings & Revenue"]
    src = "import:accounting.xlsx"
    cols = ["event_date", "client_name", "purpose", "event_type", "rental_fee", "cleaning_fee", "pet_fee", "overtime",
            "topup", "deposit_amount", "total_invoiced", "paid", "payment_mode", "remarks", "status", "source", "source_key"]
    out.append("DELETE FROM ledger_bookings WHERE source = %s;" % sql(src))
    n = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        d, name = iso(r[0]), r[1]
        if not d or not name: continue            # skips the totals row
        rental, cleaning, pet, deposit, overtime, total = num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[7]), num(r[8])
        parts = sum(x or 0 for x in (rental, cleaning, pet, deposit, overtime))
        if total is not None and abs(parts - total) > 0.5:
            report.append("  ! %s %s: components add to %s but Total Invoiced says %s (kept as written)" % (d, name, parts, total))
        paid = str(r[9] or "").strip().lower()
        out.append(insert("ledger_bookings", cols, dict(
            event_date=d, client_name=str(name).strip(), purpose=r[2], event_type=None,
            rental_fee=rental, cleaning_fee=cleaning, pet_fee=pet, overtime=overtime, topup=None,
            deposit_amount=deposit, total_invoiced=total,
            paid={"yes": "yes", "no": "no", "partial": "partial"}.get(paid), payment_mode=r[10], remarks=r[11],
            status="confirmed", source=src, source_key="acct:%s:%s" % (d, slug(name)))))
        n += 1
    # The sheet's own SUM formula starts at D3 and skips the first booking row — worth telling Carine.
    f = ws["D24"].value
    if isinstance(f, str) and f.startswith("=SUM(D3"):
        report.append("  ! accounting.xlsx cell D24 sums D3:D23, so it skips the first booking (row 2) — the dashboard sums every row.")
    return n


def import_deposits(wb, out, report):
    ws = wb["Deposit Tracking"]
    src = "import:accounting.xlsx"
    cols = ["event_date", "client_name", "deposit_collected", "deduction", "refund_amount", "refund_status",
            "topup_invoiced", "evidence", "source", "source_key"]
    out.append("DELETE FROM ledger_deposits WHERE source = %s;" % sql(src))
    n = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        d, name = iso(r[0]), r[1]
        if not d or not name: continue
        evidence = str(r[6] or "")
        m = re.search(r"\$\s*([\d,]+(?:\.\d+)?)\s*top-?up", evidence, re.I)
        out.append(insert("ledger_deposits", cols, dict(
            event_date=d, client_name=str(name).strip(), deposit_collected=num(r[2]), deduction=num(r[3]),
            refund_amount=num(r[4]), refund_status=r[5], topup_invoiced=float(m.group(1).replace(",", "")) if m else None,
            evidence=evidence or None, source=src, source_key="dep:%s:%s" % (d, slug(name)))))
        n += 1
    return n


def import_expenses(path, out, report):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Expenses"]
    src = "import:expenses-2026.xlsx"
    cols = ["expense_date", "category", "description", "amount", "paid_by", "payment_method", "receipt_file", "notes",
            "is_estimate", "source", "source_key"]
    out.append("DELETE FROM expenses WHERE source = %s;" % sql(src))
    n = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        d = iso(r[0])
        if not d or r[3] is None: continue
        cat = r[1] if r[1] in CATEGORIES else "Other"
        if r[1] not in CATEGORIES: report.append("  ! expense category %r isn't one of the standard categories — filed under Other" % r[1])
        text = "%s %s" % (r[2], r[7])
        out.append(insert("expenses", cols, dict(
            expense_date=d, category=cat, description=r[2] or cat, amount=num(r[3]), paid_by=r[4], payment_method=r[5],
            receipt_file=r[6], notes=r[7], is_estimate=1 if re.search(r"estimate", text, re.I) else 0,
            source=src, source_key="exp:%s:%s:%s" % (d, slug(cat), slug(r[2])[:40]))))
        n += 1
    return n


def import_calendar(path, out, report):
    s = Path(path).read_text(encoding="utf-8", errors="replace")
    first = s.find('"id":"new_')
    start = s.rfind("[", 0, first)
    depth, i, instr, esc = 0, start, False, False
    while i < len(s):                                   # bracket-match the embedded SEED array
        c = s[i]
        if instr:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c == "[": depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0: break
        i += 1
    leads = json.loads(s[start:i + 1])
    src = "import:lead-manager"
    cols = ["event_date", "client_name", "time_slot", "duration_hours", "purpose", "status", "deposit_status",
            "balance_status", "source", "source_key"]
    out.append("DELETE FROM calendar_imports WHERE source = %s;" % sql(src))
    n, skipped = 0, 0
    for l in leads:
        if l.get("status") not in ("Confirmed", "Soft Book"): continue
        try:
            d = datetime.strptime(l.get("event_date", ""), "%d %b %Y").strftime("%Y-%m-%d")
        except ValueError:
            skipped += 1; continue
        try: dur = float(l.get("duration")) if l.get("duration") not in (None, "") else None
        except ValueError: dur = None
        # deliberately NOT importing phone numbers or free-text notes — names and dates are enough
        out.append(insert("calendar_imports", cols, dict(
            event_date=d, client_name=str(l.get("name", "")).strip(), time_slot=l.get("time_slot") or None,
            duration_hours=dur, purpose=l.get("event_type") or None, status=l["status"],
            deposit_status=l.get("deposit_status") or None, balance_status=l.get("balance_status") or None,
            source=src, source_key="lead:%s" % l["id"])))
        n += 1
    if skipped: report.append("  ! %d confirmed/soft-booked leads have no readable event date and were skipped" % skipped)
    return n, collections.Counter(l.get("status") for l in leads)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="path to the 04_BoJioVenue folder")
    ap.add_argument("--out", default=".seed/finance-import.sql")
    a = ap.parse_args()
    root = Path(a.root)
    out, report = ["-- Generated by scripts/import_finance.py — PRIVATE (client names/amounts). Never commit."], []

    acct = openpyxl.load_workbook(root / "02_Finance" / "accounting.xlsx", data_only=False)
    nb = import_bookings(acct, out, report)
    nd = import_deposits(acct, out, report)
    ne = import_expenses(root / "02_Finance" / "2026" / "expenses-2026.xlsx", out, report)
    nc, statuses = import_calendar(root / "05_Sales-Clients" / "BojioVenue_Lead_Manager.html", out, report)

    p = Path(a.out); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("Wrote %s (%d statements)" % (p, len(out)))
    print("  ledger_bookings : %d   (accounting.xlsx → Bookings & Revenue)" % nb)
    print("  ledger_deposits : %d   (accounting.xlsx → Deposit Tracking)" % nd)
    print("  expenses        : %d   (expenses-2026.xlsx → Expenses)" % ne)
    print("  calendar_imports: %d   (Lead Manager: Confirmed + Soft Book; of %s leads)" % (nc, sum(statuses.values())))
    if report:
        print("Notes:"); print("\n".join(report))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
