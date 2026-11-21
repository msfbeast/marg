"""Monsoon full test suite. Run: .venv/bin/python tests/test_full.py
Zero-cost: never calls the Claude API (paid paths are tested for validation/guard behaviour only)."""
import json, csv, sys, urllib.request, urllib.error, pathlib, math

BASE = "http://127.0.0.1:3230"
ROOT = pathlib.Path(__file__).resolve().parent.parent
PASS, FAIL = [], []

def check(name, ok, detail=""):
    (PASS if ok else FAIL).append((name, detail))
    print(("PASS " if ok else "FAIL ") + name + ("  | " + str(detail)[:160] if detail and not ok else ""))

def get(path, timeout=10):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def post_json(path, payload, timeout=10):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200]

# ---------- A. server & API surface ----------
s, b = get("/");                 check("A1 GET / serves HTML", s == 200 and b"<!doctype html>" in b.lower() or b"<!DOCTYPE html>" in b)
s, b = get("/api/status");  st = json.loads(b)
check("A2 /api/status claude flag", s == 200 and isinstance(st.get("claude"), bool))
check("A3 /api/status daily cap fields", st.get("daily_cap_usd") == 2.0 and "today_usd" in st)
s, b = get("/api/usage");   us = json.loads(b)
check("A4 /api/usage totals consistent", s == 200 and abs(us["today_usd"] - us["all_time_usd"]) < 0.001)
ledger_sum = sum(json.loads(l).get("usd", 0) for l in (ROOT / "usage.jsonl").read_text().splitlines() if l.strip())
check("A5 usage ledger matches /api/usage", abs(ledger_sum - us["all_time_usd"]) < 0.01, f"ledger {ledger_sum} vs api {us['all_time_usd']}")
s, b = get("/data.json");   data = json.loads(b)
check("A6 /data.json served", s == 200 and len(b) > 1_000_000)
s, b = get("/wards.geojson"); geo = json.loads(b)
check("A7 wards.geojson valid, 24 features", s == 200 and geo.get("type") == "FeatureCollection" and len(geo.get("features", [])) == 24)

# ---------- B. narratives: all 32 cached, free ----------
data_dir = ROOT / "data" / "data"
wards = list(csv.DictReader(open(data_dir / "wards.csv")))
cons  = list(csv.DictReader(open(data_dir / "contractors.csv")))
expect_keys = {f"ward:{w['ward_code']}" for w in wards} | {f"contractor:{c['contractor_id']}" for c in cons}
narr = json.loads((ROOT / "app" / "narratives.json").read_text())
check("B1 narratives.json has exactly 32", len(narr) == 32, f"got {len(narr)}")
check("B2 narrative keys == 24 wards + 8 contractors", set(narr) == expect_keys, str(set(narr) ^ expect_keys))
check("B3 no empty/placeholder narratives", all(len(v) > 200 for v in narr.values()))
bad = [k for k, v in narr.items() if ("undefined" in v or "NaN" in v)]
check("B4 no undefined/NaN in narratives", not bad, str(bad))
# every narrate key serves cached (free) — sample all 32
missed = []
for k in list(expect_keys):
    kind, key = k.split(":", 1)
    s, b = get(f"/api/narrate/{kind}/{key}?cached_only=true")
    try:
        j = json.loads(b)
        if s != 200 or not j.get("text"): missed.append(k)
    except Exception: missed.append(k)
check("B5 all 32 serve from cache (no API call)", not missed, str(missed))
s, b = get("/api/narrate/ward/ZZ?cached_only=true")
try:
    jb = json.loads(b)
    check("B6a invalid key + cached_only -> 200, text null (probe contract)", s == 200 and jb.get("text") is None and jb.get("cached") is False)
except Exception as e:
    check("B6a invalid key + cached_only -> 200, text null (probe contract)", False, str(e))
s, b = get("/api/narrate/ward/ZZ")
check("B6b invalid key without cached_only -> 404 before any API call", s == 404)
s, b = get("/api/usage")
check("B6c still zero spend after invalid-key probe", abs(json.loads(b)["today_usd"] - us["today_usd"]) < 0.001)

# ---------- C. data.json integrity vs raw CSVs ----------
wos = list(csv.DictReader(open(data_dir / "work_orders.csv")))
comps = list(csv.DictReader(open(data_dir / "complaints.csv")))
rc = list(csv.DictReader(open(data_dir / "rate_card.csv")))
check("C1 work_orders count 2499", len(data["work_orders"]) == len(wos) == 2499)
check("C2 complaints count 6501", len(data["complaints"]) == len(comps) == 6501)
check("C3 wards 24 / contractors 8 / rate card 10", len(data["wards"]) == 24 and len(data["contractors"]) == 8 and len(data["rate_card"]) == 10)
total = sum(float(w["cost_inr"]) for w in wos)
totals = data.get("totals", {})
match = any(abs(v - total) < 1 for v in totals.values() if isinstance(v, (int, float)))
check("C4 city spend total present & matches CSV sum", match, f"csv {total:.0f} vs totals {totals}")

# independent audit recomputation (mirrors README table)
rate = {r["repair_method"]: r for r in rc}
dlp_roads = {r["road_id"] for r in csv.DictReader(open(data_dir / "roads.csv")) if r["under_dlp"] == "Y"}
def expected(w):
    r = rate.get(w["repair_method"])
    if not r: return None
    return float(w["area_sqm"]) * float(r["standard_rate_inr"]) if r["unit"] == "per sqm" else float(r["standard_rate_inr"])
exps = {w["work_order_id"]: expected(w) for w in wos}
over = [(w, exps[w["work_order_id"]]) for w in wos if exps[w["work_order_id"]] and float(w["cost_inr"]) / exps[w["work_order_id"]] > 1.3]
over_excess = sum(float(w["cost_inr"]) - e for w, e in over)
dlp = [w for w in wos if w["road_id"] in dlp_roads]
dlp_sum = sum(float(w["cost_inr"]) for w in dlp)
reopened = sum(1 for w in wos if w["reopened_within_30d"] == "Y")
check("C5 independent audit: 114 overbilled", len(over) == 114, str(len(over)))
check("C6 independent audit: excess Rs 6,066,314", abs(over_excess - 6066314) < 2, f"{over_excess:.0f}")
check("C7 independent audit: 493 DLP jobs", len(dlp) == 493, str(len(dlp)))
check("C8 independent audit: DLP Rs 26,225,791", abs(dlp_sum - 26225791) < 2, f"{dlp_sum:.0f}")
check("C9 independent audit: 611 reopened", reopened == 611, str(reopened))
inv = data.get("investigation", [])
check("C10 investigation log has 30 entries", len(inv) == 30, str(len(inv)))
areas = {i.get("area") for i in inv} if isinstance(inv, list) else set()
tests_txt = json.dumps(inv)
check("C10a empanelment hypothesis present (verify)", '"Procurement"' in tests_txt and '"verify"' in tests_txt and "active_wards" in tests_txt)
check("C10b surface-mismatch hypothesis present (found)", "surface" in tests_txt.lower() and '"found"' in tests_txt)
check("C10c repeat-repair finding present (50 segments / 48% of spend)", "48% of all spend" in tests_txt)
check("C10d social-post classification present", "650 posts classified" in tests_txt)
check("C10e resolved-but-failed finding present (962)", "962" in tests_txt)
# DLP records gap: flagged on every job for verification, never counted as money
gap_roads = {r["road_id"] for r in csv.DictReader(open(data_dir / "roads.csv")) if r["under_dlp"] == "N" and r["last_resurfaced"] >= "2023-01-01"}
gap_jobs = [w for w in data["work_orders"] if any(f["code"] == "DLP_RECORDS_GAP" for f in w["flags"])]
check("C10f DLP records gap flags 224 jobs (independent)", len(gap_jobs) == 224 == sum(1 for w in wos if w["road_id"] in gap_roads), str(len(gap_jobs)))
check("C10g DLP records gap is 'verify', amount 0, totals counter 224", all(f["level"] == "verify" and f["amount"] == 0 for w in gap_jobs for f in w["flags"] if f["code"] == "DLP_RECORDS_GAP") and totals.get("dlp_records_gap_jobs") == 224)
check("C10h headline unchanged: recoverable Rs 33,491,814", totals.get("recoverable_inr") == 33491814, str(totals.get("recoverable_inr")))
check("C10i gap-only jobs add no money", all(w["recoverable_inr"] == 0 for w in gap_jobs if not any(f["level"] in ("high", "review") for f in w["flags"])))
check("C10k split-billing hypothesis present (not found, 4 pairs)", any(i["test"].startswith("Same patch split") and "4 pairs" in i["result"] for i in inv))
check("C10l issue-type accuracy is computed: 4,948 linked, 95.1 vs 83.5", totals.get("issue_type_accuracy") == {"n": 4948, "filed_pct": 83.5, "cleaned_pct": 95.1, "needs_inspection": 176})
check("C10j DLP records hypothesis in the log (verify)", any(i["test"].startswith("DLP records missing") and i["verdict"] == "verify" for i in inv))
i2w = data.get("issue_to_wo", {})
valid_wo = {w["work_order_id"] for w in wos}
dangling = [k for k, v in list(i2w.items())[:2000] if isinstance(v, str) and v not in valid_wo]
check("C11 issue->WO map has no dangling ids", not dangling, str(dangling[:5]))
check("C12 plan_by_ward covers 24 wards", len(data.get("plan_by_ward", {})) == 24)

# ---------- D. API validation & guard (no spend) ----------
s, b = post_json("/api/ask", {"wrong_field": "x"})
check("D1 /api/ask invalid body -> 422 (no API call)", s == 422, f"status {s} body {b[:80]}")
s, b = get("/api/usage")
u2 = json.loads(b)
check("D2 no spend occurred during tests", abs(u2["today_usd"] - us["today_usd"]) < 0.001, f"before {us['today_usd']} after {u2['today_usd']}")

# ---------- E. static UI ----------
static = ROOT / "app" / "static"
html = (static / "index.html").read_text()
check("E1 index.html references app.js & style.css", "app.js" in html and "style.css" in html)
check("E2 app.js & style.css exist", (static / "app.js").exists() and (static / "style.css").exists())
for tab in ["Money trail", "Auditor", "Scorecards", "Next rupee", "My complaint"]:
    check(f"E3 tab label present: {tab}", tab in html or tab in (static / "app.js").read_text())
check("E4 no TODO/FIXME markers in shipped js", "TODO" not in (static / "app.js").read_text() and "FIXME" not in (static / "app.js").read_text())
import shutil
node = shutil.which("node")
if node:
    import subprocess
    r = subprocess.run([node, "--check", str(static / "app.js")], capture_output=True, text=True)
    check("E5 app.js passes node --check", r.returncode == 0, r.stderr[:200])
else:
    print("SKIP E5 (node not installed)")

# ---------- summary ----------
print(f"\n===== {len(PASS)} passed, {len(FAIL)} failed =====")
for name, d in FAIL: print("FAILED:", name, "|", d)
sys.exit(1 if FAIL else 0)
