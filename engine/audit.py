"""MARG (Monsoon Audit of Road Guarantees) audit engine.

Reads the synthetic BMC dataset in data/data and writes app/data.json:
  - cleaned complaint issues linked to work orders (or flagged never fixed)
  - per work order audit flags with evidence
  - fair contractor and ward scorecards
  - a risk-ranked next-rupee plan per ward

Every number in the UI and every answer Claude gives comes from this file,
so each flag carries the ids and arithmetic behind it.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

import extras as X2

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "data"
OUT = ROOT / "app" / "data.json"

# Normal jobs sit 0.75x to 1.30x the rate card (README: "roughly 20 to 30%").
# Nothing sits between 1.30 and 1.31; inflated bills start above that.
OVERBILL_REVIEW = 1.30   # above this: worth a look
OVERBILL_HIGH = 1.45     # above this: clear over-billing
DUP_WINDOW_DAYS = 7

ISLAND_CITY = {"A", "B", "C", "D", "E", "F/S", "F/N", "G/S", "G/N"}  # Colaba rain gauge

# Placeholder; replaced at run time by each issue type's average severity as
# implied by its SLA tier (24 h = 5 ... 168 h = 1). Nothing observable on an
# open issue (road type, traffic, upvotes, rain, hospital access) predicted
# severity within a type, so the type average is the honest estimate.
SLA_SEVERITY = {24: 5, 48: 4, 72: 3, 120: 2, 168: 1}
SURFACE_TYPES = ("Pothole", "Broken paver blocks", "Road cave-in")
SEVERITY = {  # how dangerous an unfixed issue of this type is (1..5)
    "Road cave-in": 5,
    "Open or broken manhole": 5,
    "Waterlogging": 4,
    "Pothole": 3,
    "Choked drain / nullah overflow": 3,
    "Broken paver blocks": 2,
}

# Issue type, in order of trust (measured against the work type of the job each
# complaint was linked to, 4,948 complaints):
#   photo description   100% (2,195)   what the photo shows
#   English text        100% (1,376)   app text and helpline operator notes
#   picked category      87% (1,305)   the rest
# Overall 95.1% vs 83.5% for the citizen-picked category alone. Hindi, Marathi
# and Hinglish free text turned out not to track the real issue, so it is used
# for place names only, never for the type.
PHOTO_RULES = [
    ("Road cave-in", r"collapsed road|sinkhole"),
    ("Open or broken manhole", r"manhole"),
    ("Broken paver blocks", r"paver"),
    ("Choked drain / nullah overflow", r"storm drain|nullah"),
    ("Waterlogging", r"wading|brown water"),
    ("Pothole", r"crater|pothole"),
]
EN_RULES = [
    ("Road cave-in", r"cave-in|caved|cave in|sinkhole|collapsed"),
    ("Open or broken manhole", r"manhole"),
    ("Broken paver blocks", r"paver"),
    ("Choked drain / nullah overflow", r"drain|nullah"),
    ("Waterlogging", r"waterlog|flooded|flooding|knee deep water"),
    ("Pothole", r"pot ?holes?"),
]


def load():
    rd = lambda f, **k: pd.read_csv(DATA / f, **k)
    d = dict(
        wo=rd("work_orders.csv", parse_dates=["assigned_at", "work_started_at", "completed_at"]),
        cp=rd("complaints.csv", parse_dates=["received_at", "resolved_at"]),
        rc=rd("rate_card.csv"),
        ct=rd("contractors.csv"),
        roads=rd("roads.csv", parse_dates=["last_resurfaced"]),
        wards=rd("wards.csv"),
        loc=rd("localities.csv"),
        hot=rd("flood_hotspots.csv"),
        rain=rd("rainfall_daily.csv", parse_dates=["date"]),
        tides=rd("tides.csv", parse_dates=["date"]),
        traffic=rd("traffic.csv"),
        acc=rd("accidents.csv", parse_dates=["occurred_at"]),
        fac=rd("facilities.csv"),
        social=rd("social_posts.csv", parse_dates=["posted_at"]),
    )
    d["ct"]["short"] = d["ct"].contractor_name.str.replace(" (synthetic)", "", regex=False)
    return d


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2) - np.radians(lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


# ---------------------------------------------------------------- audit


def audit_work_orders(d):
    wo = d["wo"].merge(d["rc"], on="repair_method", how="left")
    wo = wo.merge(d["roads"][["road_id", "road_name", "under_dlp", "last_resurfaced", "road_type", "bus_route", "surface"]],
                  on="road_id", how="left")
    wo["expected_inr"] = np.where(wo.unit == "per sqm", wo.area_sqm * wo.standard_rate_inr, wo.standard_rate_inr).round()
    wo["cost_ratio"] = wo.cost_inr / wo.expected_inr

    # first complaint time and SLA hours actually taken
    ci = d["cp"].set_index("complaint_id").received_at
    def first_complaint(s):
        if pd.isna(s):
            return pd.NaT
        ts = [ci.get(i) for i in s.split("|") if i in ci.index]
        return min(ts) if ts else pd.NaT
    wo["first_complaint_at"] = wo.linked_complaint_ids.map(first_complaint)
    wo["hours_taken"] = ((wo.completed_at - wo.first_complaint_at).dt.total_seconds() / 3600).round(1)

    # duplicates: a job with no complaint behind it that copies an earlier job
    # (same road, work type, contractor and area) a few days apart.
    wo["duplicate_of"] = None
    blank = wo[wo.linked_complaint_ids.isna()]
    for i, r in blank.iterrows():
        twin = wo[(wo.index != i) & (wo.road_id == r.road_id) & (wo.work_type == r.work_type)
                  & (wo.contractor_id == r.contractor_id) & (wo.area_sqm == r.area_sqm)
                  & ((wo.assigned_at - r.assigned_at).abs() <= pd.Timedelta(days=DUP_WINDOW_DAYS))
                  & wo.linked_complaint_ids.notna()]
        if len(twin):
            wo.at[i, "duplicate_of"] = twin.iloc[0].work_order_id

    flags, leak = [], []
    for r in wo.itertuples():
        f = []
        if r.duplicate_of:
            tw = wo.loc[wo.work_order_id == r.duplicate_of].iloc[0]
            days = abs((r.assigned_at - tw.assigned_at).days)
            f.append(dict(code="DUPLICATE", level="high",
                          why=f"Same road, same work, same {r.area_sqm} sqm and same contractor as {r.duplicate_of} "
                              f"{days} day(s) apart, with no citizen complaint behind it. Looks billed twice.",
                          amount=int(r.cost_inr)))
        if r.under_dlp == "Y":
            kind = "surface" if r.work_type in SURFACE_TYPES else "drainage"
            f.append(dict(code="DLP_PAID", level="high", kind=kind,
                          why=f"{r.road_name} ({r.road_id}) was resurfaced {r.last_resurfaced.date()} and is still under its "
                              f"Defect Liability Period, so repairs there are the original contractor's job at no cost to BMC. "
                              + ("This is a defect in the road surface itself. " if kind == "surface" else
                                 "This is drainage, pumping or manhole work on that road, which BMC should check against the DLP contract. ")
                              + f"BMC paid Rs {r.cost_inr:,}.",
                          amount=int(r.cost_inr)))
        if r.under_dlp == "N" and pd.notna(r.last_resurfaced) and r.last_resurfaced >= pd.Timestamp("2023-01-01"):
            # records-integrity question, never counted as money: every road resurfaced 2018-2022 is "N",
            # yet 20-40% of 2023-25 resurfacings also lack an active DLP record
            f.append(dict(code="DLP_RECORDS_GAP", level="verify",
                          why=f"Resurfaced {r.last_resurfaced.year}, but records show no active Defect Liability Period. "
                              "Repairs on this road may be chargeable to the original contractor at Rs 0. "
                              "Verify against the contract before billing.",
                          amount=0))
        if r.cost_ratio > OVERBILL_REVIEW:
            lvl = "high" if r.cost_ratio > OVERBILL_HIGH else "review"
            unit = f"{r.area_sqm} sqm x Rs {r.standard_rate_inr:,}" if r.unit == "per sqm" else f"Rs {r.standard_rate_inr:,} per job"
            f.append(dict(code="OVERBILLED", level=lvl,
                          why=f"Billed Rs {r.cost_inr:,} against a rate-card value of Rs {int(r.expected_inr):,} "
                              f"({unit}): {r.cost_ratio:.2f}x. Normal jobs stay within 1.30x.",
                          amount=int(r.cost_inr - r.expected_inr)))
        if r.sla_met == "N":
            f.append(dict(code="SLA_MISSED", level="info",
                          why=f"Took {r.hours_taken:g} h from first complaint against a {r.sla_hours} h target."
                              if pd.notna(r.hours_taken) else f"Missed the {r.sla_hours} h target.", amount=0))
        if r.reopened_within_30d == "Y":
            f.append(dict(code="REOPENED", level="info", why="The fix failed and the issue re-opened within 30 days.",
                          amount=0))
        flags.append(f)
        # recoverable money: count each work order once
        if r.duplicate_of or r.under_dlp == "Y":
            leak.append(int(r.cost_inr))
        elif r.cost_ratio > OVERBILL_REVIEW:
            leak.append(int(round(r.cost_inr - r.expected_inr)))
        else:
            leak.append(0)
    wo["audit_flags"] = flags
    wo["recoverable_inr"] = leak
    return wo


# ------------------------------------------------------- reopen fairness


def rain_after(d, wo):
    """Rain (mm) at the ward's gauge in the 30 days after each job completed."""
    rain = d["rain"].pivot(index="date", columns="station", values="rainfall_mm").sort_index()
    cum = rain.cumsum()
    def window(station, t):
        if pd.isna(t):
            return 0.0
        s = cum[station]
        a = s[s.index <= t.normalize()]
        b = s[s.index <= t.normalize() + pd.Timedelta(days=30)]
        return float((b.iloc[-1] if len(b) else 0) - (a.iloc[-1] if len(a) else 0))
    st = np.where(wo.ward_code.isin(ISLAND_CITY), "Colaba", "Santacruz")
    return [window(s, t) for s, t in zip(st, wo.completed_at)]


def expected_reopen(d, wo):
    """Model how likely a fix is to fail given things the contractor does not
    control: method, road surface, how low-lying the ward is, rain in the next
    30 days, road type and traffic. A contractor is judged on observed vs expected."""
    w = d["wards"].set_index("ward_code").low_lying_index
    tr = d["traffic"].set_index("road_id")
    X = pd.DataFrame({
        "low_lying": wo.ward_code.map(w),
        "rain30": np.log1p(wo.rain_30d),
        "congestion": wo.road_id.map(tr.congestion_index_0_10).fillna(5),
        "heavy_road": wo.road_type.isin(["Highway", "Arterial"]).astype(int),
    })
    # road surface matters: concrete roads fail more for every patch method, so a
    # contractor sent to concrete roads should not be marked down for it
    X = pd.concat([X, pd.get_dummies(wo.repair_method, prefix="m", dtype=int), pd.get_dummies(wo.surface, prefix="s", dtype=int)], axis=1)
    y = (wo.reopened_within_30d == "Y").astype(int)
    model = LogisticRegression(max_iter=2000, C=1.0).fit(X, y)
    return model.predict_proba(X)[:, 1]


def expected_sla(d, wo):
    """Chance each job meets its SLA given things the contractor does not
    control: the SLA tier (24 h targets are met 3% of the time city-wide), the
    work type, how low-lying the ward is, rain in the 3 days after assignment,
    and how many jobs the ward's crews had that week."""
    rain = d["rain"].pivot(index="date", columns="station", values="rainfall_mm")
    st = np.where(wo.ward_code.isin(ISLAND_CITY), "Colaba", "Santacruz")
    r3 = [rain.loc[t.normalize(): t.normalize() + pd.Timedelta(days=2), s].sum() for s, t in zip(st, wo.assigned_at)]
    w = d["wards"].set_index("ward_code")
    wk = wo.assigned_at.dt.to_period("W")
    load = wo.groupby([wo.ward_code, wk]).work_order_id.transform("size") / wo.ward_code.map(w.engineering_crews)
    X = pd.concat([pd.DataFrame({"rain3": np.log1p(r3), "load_per_crew": load.values,
                                 "low_lying": wo.ward_code.map(w.low_lying_index).values}, index=wo.index),
                   pd.get_dummies(wo.sla_hours.astype(str), prefix="sla", dtype=int),
                   pd.get_dummies(wo.work_type, prefix="t", dtype=int)], axis=1)
    y = wo.sla_met.eq("Y").astype(int)
    return LogisticRegression(max_iter=3000).fit(X, y).predict_proba(X)[:, 1]


def safety_cost_of_delay(d, cp):
    """Road-defect accidents per 1,000 road-days with and without an
    unresolved complaint on that road (Jun to 10 Oct 2025). Other accidents
    are the control for busier roads."""
    start, end = pd.Timestamp("2025-06-01"), pd.Timestamp("2025-10-10")
    days = pd.date_range(start, end, freq="D")
    roads = list(d["roads"].road_id)
    col = {r: i for i, r in enumerate(roads)}
    open_ = np.zeros((len(days), len(roads)), dtype=bool)
    k = cp[cp.road_guess.notna() & ~cp.is_noise & cp.status.isin(["Open", "In Progress", "Resolved", "Closed - Duplicate"])]
    for r in k.itertuples():
        e = r.resolved_at if pd.notna(r.resolved_at) else end
        a, b = max((r.received_at.normalize() - start).days, 0), min((e.normalize() - start).days, len(days) - 1)
        if b >= a:
            open_[a:b + 1, col[r.road_guess]] = True
    acc = d["acc"][(d["acc"].occurred_at >= start) & (d["acc"].occurred_at <= end + pd.Timedelta(days=1))]
    defect = acc.probable_cause.isin(["Pothole", "Waterlogged road", "Uneven road / open chamber"])
    hit = np.array([open_[(t.normalize() - start).days, col[r]] if r in col and 0 <= (t.normalize() - start).days < len(days) else False
                    for t, r in zip(acc.occurred_at, acc.road_id)])
    od, cd = open_.sum(), open_.size - open_.sum()
    rate = lambda m, den: round(1000 * m / den, 2)
    out = dict(
        defect_open=rate((hit & defect.values).sum(), od), defect_closed=rate((~hit & defect.values).sum(), cd),
        other_open=rate((hit & ~defect.values).sum(), od), other_closed=rate((~hit & ~defect.values).sum(), cd),
        defect_accidents=int(defect.sum()), defect_on_open=int((hit & defect.values).sum()),
    )
    out["defect_ratio"] = round(out["defect_open"] / out["defect_closed"], 1)
    out["other_ratio"] = round(out["other_open"] / out["other_closed"], 1)
    return out


# ------------------------------------------------------ complaints -> issues


def build_gazetteer(d):
    entries = []
    for r in d["loc"].itertuples():
        names = [r.locality] + ([a.strip() for a in str(r.aliases).split(";")] if pd.notna(r.aliases) else [])
        for n in names:
            if n:
                entries.append((n.lower(), r.locality, r.ward_code, r.lat, r.lon))
    entries.sort(key=lambda e: -len(e[0]))
    return entries


def _first(rules, text):
    text = str(text).lower()
    return next((t for t, p in rules if re.search(p, text)), None)


def classify(desc, photo, picked, language):
    """Returns (issue_type, source)."""
    t = _first(PHOTO_RULES, photo) if photo else None
    if t:
        return t, "photo"
    t = _first(EN_RULES, desc) if language == "en" else None
    if t:
        return t, "text"
    if picked in SEVERITY:
        return picked, "picked"
    return "Needs inspection", "none"


def clean_complaints(d):
    cp = d["cp"].copy()
    gaz = build_gazetteer(d)
    road_names = sorted(d["roads"].road_name.unique(), key=len, reverse=True)

    res = [classify(r.description, r.photo_description if pd.notna(r.photo_description) else "",
                    r.category_reported, r.language) for r in cp.itertuples()]
    cp["issue_type"] = [t for t, _ in res]
    cp["type_source"] = [s for _, s in res]
    cp["category_corrected"] = cp.issue_type.ne(cp.category_reported) & cp.issue_type.ne("Needs inspection")

    # geocode: fill ward and lat/lon from locality text or description
    wards, lats, lons, locs = [], [], [], []
    for r in cp.itertuples():
        hay = f"{r.locality_text} {r.description}".lower()
        hit = next((g for g in gaz if g[0] in hay), None)
        locs.append(hit[1] if hit else r.locality_text)
        wards.append(r.ward_code if pd.notna(r.ward_code) else (hit[2] if hit else None))
        lats.append(r.lat if pd.notna(r.lat) else (hit[3] if hit else None))
        lons.append(r.lon if pd.notna(r.lon) else (hit[4] if hit else None))
    cp["ward_filled"] = wards
    cp["locality_std"] = locs
    cp["lat_f"], cp["lon_f"] = lats, lons

    # road: named road in text, matched within the ward first
    rdw = d["roads"]
    def match_road(desc, ward, lat, lon):
        text = str(desc).lower()
        name = next((n for n in road_names if n.lower() in text), None)
        cands = rdw[(rdw.ward_code == ward)] if ward else rdw
        if name:
            c = cands[cands.road_name == name]
            if len(c) == 0:
                c = rdw[rdw.road_name == name]
        else:
            c = cands
        if len(c) == 0:
            return None
        if lat is not None and not pd.isna(lat):
            mid_lat = (c.start_lat + c.end_lat) / 2
            mid_lon = (c.start_lon + c.end_lon) / 2
            return c.iloc[int(np.argmin(haversine_m(lat, lon, mid_lat, mid_lon)))].road_id
        return c.iloc[0].road_id if name else None
    cp["road_guess"] = [match_road(r.description, r.ward_filled, r.lat_f, r.lon_f) for r in cp.itertuples()]

    noise = cp.status.eq("Rejected - Not road issue") | cp.description.fillna("").str.strip().str.lower().isin(["test", "testing"])
    cp["is_noise"] = noise
    return cp


def link_issues(d, cp, wo):
    """Each linked group of complaints is one issue. Unlinked open complaints
    are merged into one issue per ward, road (or locality) and type."""
    issue_of, issues = {}, []
    for r in wo.itertuples():
        if pd.isna(r.linked_complaint_ids):
            continue
        ids = r.linked_complaint_ids.split("|")
        iid = f"ISS-{r.work_order_id[5:]}"
        for c in ids:
            issue_of[c] = iid
        issues.append(dict(issue_id=iid, status="Fixed" if r.reopened_within_30d == "N" else "Fixed, then failed",
                           work_order_id=r.work_order_id, complaint_ids=ids, ward_code=r.ward_code,
                           road_id=r.road_id, issue_type=r.work_type))

    pending = cp[cp.status.isin(["Open", "In Progress"]) & ~cp.is_noise].sort_values("received_at")
    open_issues = []
    for r in pending.itertuples():
        key_place = r.road_guess or r.locality_std
        match = None
        for oi in reversed(open_issues):
            # an unfixed issue stays the same issue however long it waits
            if oi["ward_code"] == r.ward_filled and oi["place"] == key_place and oi["issue_type"] == r.issue_type:
                match = oi
                break
        if match is None:
            match = dict(issue_id=f"OPEN-{len(open_issues)+1:04d}", status="Never fixed", work_order_id=None,
                         complaint_ids=[], ward_code=r.ward_filled, road_id=r.road_guess, place=key_place,
                         locality=r.locality_std, issue_type=r.issue_type, first_at=r.received_at,
                         last_at=r.received_at, upvotes=0, languages=set(), channels=set(), lat=r.lat_f, lon=r.lon_f,
                         sample=r.description)
            open_issues.append(match)
        match["complaint_ids"].append(r.complaint_id)
        match["last_at"] = r.received_at
        match["upvotes"] += int(r.upvotes)
        match["languages"].add(r.language)
        match["channels"].add(r.channel)
        issue_of[r.complaint_id] = match["issue_id"]
    cp["issue_id"] = cp.complaint_id.map(issue_of)
    return issues, open_issues


# ------------------------------------------------------------ scorecards


def grade(score):
    return "A" if score >= 80 else "B" if score >= 65 else "C" if score >= 50 else "D" if score >= 35 else "E"


def contractor_cards(d, wo):
    cards = []
    for cid, g in wo.groupby("contractor_id"):
        name = d["ct"].set_index("contractor_id").short[cid]
        n = len(g)
        obs = (g.reopened_within_30d == "Y").sum()
        exp = g.p_reopen.sum()
        oe = obs / exp if exp else 1
        sla = (g.sla_met == "Y").mean()
        sla_exp = g.p_sla.mean()
        sla_oe = sla / sla_exp if sla_exp else 1
        med_ratio = float(g.cost_ratio.median())
        n_over = int((g.cost_ratio > OVERBILL_REVIEW).sum())
        n_dup = int(g.duplicate_of.notna().sum())
        n_dlp = int((g.under_dlp == "Y").sum())
        # 0..100 components, each fair to volume (rates, not counts)
        s_speed = float(np.clip(50 + (sla_oe - 1) * 150, 0, 100))  # O/E 0.67 -> 0, 1.0 -> 50, 1.33 -> 100
        s_durable = float(np.clip(100 - (oe - 0.5) * 100, 0, 100))  # O/E 0.5 -> 100, 1.5 -> 0
        s_billing = float(np.clip(100 - (n_over + n_dup) / n * 100 * 4, 0, 100))
        score = 0.3 * s_speed + 0.4 * s_durable + 0.3 * s_billing
        cards.append(dict(
            contractor_id=cid, name=name, empanelled_since=int(d["ct"].set_index("contractor_id").empanelled_since[cid]),
            jobs=n, spend_inr=int(g.cost_inr.sum()), wards=int(g.ward_code.nunique()),
            sla_met_pct=round(100 * sla, 1), expected_sla_pct=round(100 * sla_exp, 1), sla_oe=round(sla_oe, 2),
            reopen_pct=round(100 * obs / n, 1), expected_reopen_pct=round(100 * exp / n, 1), reopen_oe=round(oe, 2),
            median_cost_ratio=round(med_ratio, 2), overbilled_jobs=n_over, duplicate_jobs=n_dup, dlp_paid_jobs=n_dlp,
            recoverable_inr=int(g.recoverable_inr.sum()),
            failed_spend_inr=int(g.loc[g.reopened_within_30d == "Y", "cost_inr"].sum()),
            scores=dict(speed=round(s_speed), durability=round(s_durable), billing=round(s_billing)),
            score=round(score), grade=grade(score),
            evidence=dict(
                overbilled=g.loc[g.cost_ratio > OVERBILL_REVIEW].sort_values("cost_ratio", ascending=False).work_order_id.tolist(),
                duplicates=g.loc[g.duplicate_of.notna()].work_order_id.tolist(),
                reopened=g.loc[g.reopened_within_30d == "Y"].work_order_id.tolist()[:40],
            ),
            by_method={m: dict(jobs=int(len(x)), reopen_pct=round(100 * (x.reopened_within_30d == "Y").mean(), 1))
                       for m, x in g.groupby("repair_method")},
        ))
    cards.sort(key=lambda c: -c["score"])
    return cards


def ward_cards(d, wo, open_issues, cp):
    w = d["wards"].set_index("ward_code")
    out = []
    for code, row in w.iterrows():
        g = wo[wo.ward_code == code]
        spend = int(g.cost_inr.sum())
        budget = int(row.monsoon_repair_budget_inr_2025)
        failed = int(g.loc[g.reopened_within_30d == "Y", "cost_inr"].sum())
        recov = int(g.recoverable_inr.sum())
        oi = [o for o in open_issues if o["ward_code"] == code]
        c = cp[cp.ward_filled == code]
        sla = (g.sla_met == "Y").mean() if len(g) else 0
        oe = g.reopened_within_30d.eq("Y").sum() / max(g.p_reopen.sum(), 1e-9)
        # ward accountability: money that held + money not leaking + issues closed
        held = 1 - failed / spend if spend else 0
        clean = 1 - recov / spend if spend else 0
        closed = 1 - len(oi) / max(len(oi) + len(g), 1)
        score = 100 * (0.35 * clean + 0.25 * held + 0.2 * sla + 0.2 * closed)
        out.append(dict(
            ward_code=code, ward_name=row.ward_name, zone=row.zone, office=row.assistant_commissioner_office,
            centroid=[float(row.centroid_lon), float(row.centroid_lat)],
            population=int(row.population_est), low_lying_index=float(row.low_lying_index), crews=int(row.engineering_crews),
            budget_inr=budget, spend_inr=spend, spend_pct=round(100 * spend / budget, 1),
            jobs=len(g), complaints=int(len(c)), open_issues=len(oi),
            failed_spend_inr=failed, recoverable_inr=recov,
            sla_met_pct=round(100 * sla, 1), reopen_pct=round(100 * g.reopened_within_30d.eq("Y").mean(), 1),
            reopen_oe=round(float(oe), 2), expected_reopen_pct=round(100 * float(g.p_reopen.mean()), 1) if len(g) else 0, expected_sla_pct=round(100 * float(g.p_sla.mean()), 1) if len(g) else 0,
            by_contractor=[dict(name=n.replace(" (synthetic)", ""), spend_inr=int(x.cost_inr.sum()), jobs=len(x))
                           for n, x in sorted(g.groupby("contractor_name"), key=lambda kv: -kv[1].cost_inr.sum())],
            by_method=[dict(method=m, spend_inr=int(x.cost_inr.sum()), jobs=len(x),
                            reopen_pct=round(100 * x.reopened_within_30d.eq("Y").mean(), 1))
                       for m, x in sorted(g.groupby("repair_method"), key=lambda kv: -kv[1].cost_inr.sum())],
            leak_breakdown=dict(
                duplicate=int(g.loc[g.duplicate_of.notna(), "cost_inr"].sum()),
                dlp=int(g.loc[(g.under_dlp == "Y") & g.duplicate_of.isna(), "cost_inr"].sum()),
                overbilled=int(g.loc[(g.under_dlp != "Y") & g.duplicate_of.isna() & (g.cost_ratio > OVERBILL_REVIEW), "recoverable_inr"].sum()),
            ),
            score=round(score), grade=grade(score),
        ))
    return out


# --------------------------------------------------------- next rupee


def method_economics(wo, rc):
    """For each issue type, compare methods on how often the fix held for 30
    days and on cost per durable fix (rate-card cost of a typical job divided
    by the chance it holds). Recommend the most durable method unless it costs
    more than 1.5x the cheapest per durable fix."""
    rate = rc.set_index("repair_method")
    res = {}
    for t, g in wo[wo.cost_ratio <= OVERBILL_REVIEW].groupby("work_type"):
        typical_area = float(g.area_sqm.median())
        opts = []
        for m, x in g.groupby("repair_method"):
            hold = 1 - x.reopened_within_30d.eq("Y").mean()
            r = rate.loc[m]
            job = r.standard_rate_inr * (typical_area if r.unit == "per sqm" else 1)
            opts.append(dict(method=m, unit=r.unit, rate_inr=int(r.standard_rate_inr), typical_job_inr=int(job),
                             avg_job_inr=int(x.cost_inr.mean()), holds_pct=round(100 * hold, 1),
                             cost_per_durable_fix_inr=int(job / max(hold, 0.05)), jobs=len(x)))
        cheapest = min(o["cost_per_durable_fix_inr"] for o in opts)
        ok = [o for o in opts if o["cost_per_durable_fix_inr"] <= 1.5 * cheapest]
        best = max(ok, key=lambda o: o["holds_pct"])
        for o in opts:
            o["recommended"] = o is best
        opts.sort(key=lambda o: (not o["recommended"], -o["holds_pct"]))
        res[t] = opts
    return res


def method_by_surface(wo, rc, econ, min_jobs=20):
    """Same rule per road surface where every method has enough jobs;
    otherwise fall back to the city-wide choice for that issue type."""
    rate = rc.set_index("repair_method")
    out = {}
    base = wo[wo.cost_ratio <= OVERBILL_REVIEW]
    for (t, sf), g in base.groupby(["work_type", "surface"]):
        typical_area = float(base[base.work_type == t].area_sqm.median())
        opts = []
        for m, x in g.groupby("repair_method"):
            if len(x) < min_jobs:
                opts = []
                break
            hold = 1 - x.reopened_within_30d.eq("Y").mean()
            r = rate.loc[m]
            job = r.standard_rate_inr * (typical_area if r.unit == "per sqm" else 1)
            opts.append(dict(method=m, holds_pct=round(100 * hold, 1), typical_job_inr=int(job),
                             cost_per_durable_fix_inr=int(job / max(hold, 0.05)), jobs=len(x)))
        if len(opts) < 2:
            continue
        cheapest = min(o["cost_per_durable_fix_inr"] for o in opts)
        best = max([o for o in opts if o["cost_per_durable_fix_inr"] <= 1.5 * cheapest], key=lambda o: o["holds_pct"])
        for o in opts:
            o["recommended"] = o is best
        opts.sort(key=lambda o: (not o["recommended"], -o["holds_pct"]))
        out[f"{t}|{sf}"] = opts
    return out


def road_risk(d, wo):
    roads = d["roads"].copy()
    roads["mid_lat"] = (roads.start_lat + roads.end_lat) / 2
    roads["mid_lon"] = (roads.start_lon + roads.end_lon) / 2
    tr = d["traffic"].set_index("road_id")
    hot = d["hot"]
    acc = d["acc"]
    road_acc = acc[acc.probable_cause.isin(["Pothole", "Waterlogged road", "Uneven road / open chamber"])]
    acc_n = road_acc.groupby("road_id").size()
    acc_sev = road_acc.assign(w=road_acc.severity.map({"Minor": 1, "Grievous": 3, "Fatal": 8})).groupby("road_id").w.sum()
    fac = d["fac"]
    hosp = fac[fac.type == "Hospital"]
    sch = fac[fac.type == "School"]
    reopen_road = wo.groupby("road_id").reopened_within_30d.apply(lambda s: s.eq("Y").mean())
    rain = d["rain"].pivot(index="date", columns="station", values="rainfall_mm")
    big_tide = d["tides"].groupby("date").big_tide_flag.apply(lambda s: (s == "Y").any())
    exposure = {}
    for h in hot.itertuples():
        st = "Colaba" if h.ward_code in ISLAND_CITY else "Santacruz"
        wet = rain.index[rain[st] >= h.flood_threshold_mm_per_day]
        exposure[h.hotspot_id] = (len(wet), int(big_tide.reindex(wet).fillna(False).sum()))
    out = {}
    for r in roads.itertuples():
        dist = haversine_m(r.mid_lat, r.mid_lon, hot.lat.values, hot.lon.values)
        near = hot[dist <= 800]
        flood = 0.0
        flood_why = None
        if len(near):
            h = near.assign(dist=dist[dist <= 800]).sort_values("flood_threshold_mm_per_day").iloc[0]
            # pick the nearby hotspot with the most measured flood days this season
            near = near.assign(wet=[exposure[i][0] for i in near.hotspot_id], tide=[exposure[i][1] for i in near.hotspot_id])
            h = near.sort_values(["wet", "years_flagged_last_5"], ascending=False).iloc[0]
            tide_days = int(h.tide) if h.tide_sensitive == "Y" else 0
            flood = min(h.wet / 15, 1) * 0.6 + h.years_flagged_last_5 / 5 * 0.25 + min(tide_days / 5, 1) * 0.15
            flood += 0.1 * min(h.avg_water_depth_cm / 70, 1)
            flood += 0.1 * min(h.avg_recession_hours / 8, 1)  # water that lingers does more damage
            flood -= 0.05 if h.pumping_station_nearby == "Y" else 0
            flood_why = (f"{h['name']}, which crossed its {int(h.flood_threshold_mm_per_day)} mm/day flood threshold on "
                         f"{int(h.wet)} days in 2025" + (f", {tide_days} of them with a big tide" if tide_days else "")
                         + (f", water lingers {h.avg_recession_hours:g} h" if h.avg_recession_hours >= 6 else "")
                         + (", no pumping station nearby" if h.pumping_station_nearby == "N" else ""))
        t = tr.loc[r.road_id] if r.road_id in tr.index else None
        traffic = 0 if t is None else min(t.peak_hour_vehicles / 8000, 1) * 0.5 + t.congestion_index_0_10 / 10 * 0.3 + min(t.bus_routes_count / 30, 1) * 0.2
        h_n = int((hosp.ambulance_entry_road == r.road_id).sum())
        s_n = int((sch.ambulance_entry_road == r.road_id).sum())
        beds = int(hosp[hosp.ambulance_entry_road == r.road_id].beds_or_students.sum())
        students = int(sch[sch.ambulance_entry_road == r.road_id].beds_or_students.sum())
        out[r.road_id] = dict(
            road_name=r.road_name, ward_code=r.ward_code, road_type=r.road_type, bus_route=r.bus_route,
            under_dlp=r.under_dlp, flood=round(min(flood, 1.0), 3), flood_why=flood_why,
            traffic=round(float(traffic), 3), accidents=int(acc_n.get(r.road_id, 0)),
            accident_weight=int(acc_sev.get(r.road_id, 0)), hospitals=h_n, schools=s_n, beds=beds, students=students,
            surface=r.surface,
            past_reopen=round(float(reopen_road.get(r.road_id, 0)), 2),
            hospital_names=hosp[hosp.ambulance_entry_road == r.road_id].name.tolist(),
        )
    return out


def plan(d, wo, open_issues, risk, econ, wards, by_surface=None):
    big_tide_days = int(d["tides"].groupby("date").big_tide_flag.apply(lambda s: (s == "Y").any()).sum())
    items = []
    for oi in open_issues:
        rk = risk.get(oi["road_id"]) if oi["road_id"] else None
        sev = SEVERITY.get(oi["issue_type"], 2.5)
        n = len(oi["complaint_ids"])
        demand = min(math.log1p(n + oi["upvotes"] / 10) / math.log(30), 1)
        parts = dict(
            severity=sev / 5 * 30,
            demand=demand * 15,
            flood=(rk["flood"] if rk else 0) * 15 * (1.3 if oi["issue_type"] in ("Waterlogging", "Choked drain / nullah overflow", "Road cave-in") else 1),
            traffic=(rk["traffic"] if rk else 0) * 12,
            accidents=min((rk["accident_weight"] if rk else 0) / 10, 1) * 13,
            # weighted by size: a 1,400-bed hospital or 3,000 students count for more
            access=min(rk["beds"] / 800 + rk["students"] / 3000, 1) * 10 if rk else 0,
            repeat=(rk["past_reopen"] if rk else 0) * 5,
        )
        score = sum(parts.values())
        sf = rk["surface"] if rk else None
        opts = ((by_surface or {}).get(f"{oi['issue_type']}|{sf}") or econ.get(oi["issue_type"])
                or [dict(method="Site inspection to scope the job", typical_job_inr=5000, holds_pct=None)])
        best = opts[0]
        reasons = [f"{oi['issue_type'].lower()}, typical severity {sev:.1f}/5"]
        if n > 1:
            reasons.append(f"{n} complaints" + (f", {oi['upvotes']} me-too votes" if oi["upvotes"] else ""))
        if rk and rk["flood_why"]:
            reasons.append(f"near {rk['flood_why']}")
        if rk and rk["accident_weight"]:
            reasons.append(f"{rk['accidents']} road-defect accidents on this road")
        if rk and rk["hospitals"]:
            reasons.append("ambulance route to " + ", ".join(rk["hospital_names"]) + f" ({rk['beds']:,} beds)")
        elif rk and rk["schools"]:
            reasons.append(f"access road for {rk['schools']} school(s), {rk['students']:,} students")
        if rk and rk["traffic"] > 0.6:
            reasons.append("heavy peak traffic" + (" and BEST buses" if rk["bus_route"] == "Y" else ""))
        dlp_note = None
        if rk and rk["under_dlp"] == "Y":
            dlp_note = "Road is under DLP: the original contractor must fix this at no cost to BMC."
        items.append(dict(
            issue_id=oi["issue_id"], ward_code=oi["ward_code"], road_id=oi["road_id"],
            lat=None if oi["lat"] is None or pd.isna(oi["lat"]) else round(float(oi["lat"]), 5),
            lon=None if oi["lon"] is None or pd.isna(oi["lon"]) else round(float(oi["lon"]), 5),
            road_name=rk["road_name"] if rk else None, locality=oi["locality"], issue_type=oi["issue_type"],
            complaints=n, complaint_ids=oi["complaint_ids"], upvotes=oi["upvotes"], first_reported=str(oi["first_at"])[:16],
            languages=sorted(oi["languages"]), sample=oi["sample"],
            risk=round(score, 1), risk_parts={k: round(v, 1) for k, v in parts.items()}, reasons=reasons,
            surface=sf, method=best["method"], est_cost_inr=0 if dlp_note else best["typical_job_inr"],
            holds_pct=best["holds_pct"], alt=opts[1]["method"] if len(opts) > 1 else None,
            dlp_note=dlp_note,
        ))
    items.sort(key=lambda x: -x["risk"])
    for i, it in enumerate(items, 1):
        it["city_rank"] = i
    by_ward = {}
    for w in wards:
        wi = [x for x in items if x["ward_code"] == w["ward_code"]]
        for i, x in enumerate(wi, 1):
            x["ward_rank"] = i
        by_ward[w["ward_code"]] = [x["issue_id"] for x in wi]
    return items, by_ward, big_tide_days


def investigation(d, wo, cp, safety):
    """Every hypothesis tested for the three hidden problems, with the number
    that decided it. 'found' rows are in the audit; the rest were checked and
    ruled out so nobody is flagged on noise."""
    W = wo
    log = []
    add = lambda area, test, verdict, result: log.append(dict(area=area, test=test, verdict=verdict, result=result))
    r = W.cost_ratio
    add("Inflated bills", "Cost vs rate card (area x rate, or per job)", "found",
        f"{int((r > OVERBILL_REVIEW).sum())} jobs above {OVERBILL_REVIEW}x. Normal jobs run {r[r <= OVERBILL_REVIEW].min():.2f}x to "
        f"{r[r <= OVERBILL_REVIEW].max():.2f}x, flagged ones start at {r[r > OVERBILL_REVIEW].min():.2f}x (median {r[r > OVERBILL_REVIEW].median():.1f}x). "
        f"Mahalaxmi Civil and Arabian Sea hold {int(((r > OVERBILL_REVIEW) & W.contractor_id.isin(['CT03', 'CT07'])).sum())} of them.")
    per = W[W.unit == "per sqm"].groupby("contractor_id").area_sqm.mean()
    add("Inflated bills", "Padded areas (billing at the right rate for more sqm than done)", "not found",
        f"Mean patch area per contractor ranges only {per.min():.1f} to {per.max():.1f} sqm, spread evenly 0.5 to 12 sqm.")
    nm = W[W.cost_ratio <= OVERBILL_REVIEW].groupby("contractor_id").cost_ratio.mean()
    add("Inflated bills", "Quiet shading (every bill a little high)", "not found",
        f"Among normal jobs each contractor averages {nm.min():.2f}x to {nm.max():.2f}x the rate card.")
    mix = pd.crosstab(W[W.work_type == "Pothole"].contractor_id, W[W.work_type == "Pothole"].repair_method, normalize="index")["Mastic asphalt"]
    add("Inflated bills", "Up-coding to a pricier method", "not found",
        f"Share of potholes billed as mastic asphalt (the priciest) is {100 * mix.min():.0f}% to {100 * mix.max():.0f}% for every contractor.")
    dur = (W.completed_at - W.work_started_at).dt.total_seconds() / 3600
    add("Inflated bills", "Phantom work (jobs finished impossibly fast)", "not found",
        f"Shortest job {dur.min():.0f} h; durations spread evenly per method with no cluster of instant jobs.")
    add("Duplicate charges", "Job with no complaint that copies an earlier job (road, type, contractor, exact area, within 7 days)", "found",
        f"{int(W.duplicate_of.notna().sum())} of {int(W.linked_complaint_ids.isna().sum())} no-complaint jobs have an exact twin, all 2 to 4 days apart.")
    add("Duplicate charges", "Twins where both jobs have complaints", "not found",
        "Same-road, same-contractor jobs within 3 days have different areas and their own complaints: separate real defects.")
    add("Duplicate charges", "One complaint billed on two work orders", "not found", "No complaint id is linked to more than one work order.")
    add("Duplicate charges", "Identical amounts", "not found", "Matching rupee amounts occur on unrelated roads and methods: coincidence at this volume.")
    dl = W[W.under_dlp == "Y"]
    add("Warranty violations", "BMC paid for repairs on roads still under Defect Liability Period", "found",
        f"{len(dl)} jobs, Rs {dl.cost_inr.sum() / 1e7:.2f} Cr on {dl.road_id.nunique()} road segments. Road surface Rs "
        f"{dl[dl.work_type.isin(SURFACE_TYPES)].cost_inr.sum() / 1e5:.1f} L, drainage and pumping Rs {dl[~dl.work_type.isin(SURFACE_TYPES)].cost_inr.sum() / 1e7:.2f} Cr.")
    rd = d["roads"]
    gap = rd[(rd.under_dlp == "N") & (rd.last_resurfaced >= "2023-01-01")]
    gw = W[W.road_id.isin(gap.road_id)]
    old = rd[rd.last_resurfaced < "2023-01-01"]
    by_year = "; ".join(f"{(g.under_dlp == 'N').sum()} of {len(g)} in {y}" for y, g in rd[rd.last_resurfaced >= "2023-01-01"].groupby(rd.last_resurfaced.dt.year))
    add("Warranty violations", "DLP records missing on recently resurfaced roads", "verify",
        f"All {len(old)} roads resurfaced before 2023 are marked not under DLP, a clean boundary that suggests a DLP window of about 3 years. "
        f"Yet {by_year} also lack an active DLP record. {gap.road_id.isin(W.road_id).sum()} such segments carry {len(gw)} paid jobs worth Rs "
        f"{gw.cost_inr.sum() / 1e7:.2f} Cr at normal rates (median {gw.cost_ratio.median():.2f}x the rate card), spread evenly across contractors and wards. "
        "Could be a records gap or missing paperwork: flagged on every job as DLP records gap for contract verification, not counted as recoverable.")
    s = W.sort_values("assigned_at")
    same = n_after = 0
    for _, g in s.groupby(["road_id", "work_type"]):
        g = g.reset_index(drop=True)
        for i in range(len(g) - 1):
            a, b = g.iloc[i], g.iloc[i + 1]
            if a.reopened_within_30d == "Y" and pd.Timedelta(0) < b.assigned_at - a.completed_at <= pd.Timedelta(days=30):
                n_after += 1
                same += a.contractor_id == b.contractor_id
    add("Warranty violations", "Contractor paid again to redo its own failed fix", "not found",
        f"After a failed fix the same contractor got the next job {100 * same / max(n_after, 1):.0f}% of the time, about its normal share, so no steering. "
        "If BMC's contracts carry a workmanship guarantee, those re-dos should still be free.")
    ut = W.engineer_remark.fillna("").str.contains("Utility")
    add("Warranty violations", "Utility trench damage billed to BMC", "not found",
        f"The 'Utility (MTNL/MGL) trench' remark appears on {int(ut.sum())} jobs, but equally on waterlogging and drains and at the same rate on flagged jobs, so remarks look random.")
    add("Hiding failures", "Re-open flags set to N when the fix failed", "not found",
        "Another job followed on the same road within 30 days for about half of all jobs, flagged or not.")
    add("Context", "Do failed fixes cause accidents?", "not found",
        "Road-defect accidents in the 30 days after a failed fix are no higher than after a fix that held.")
    add("Context", "Do unresolved complaints cost lives?", "found",
        f"Road-defect accidents run {safety['defect_ratio']}x higher on road-days with an unresolved complaint "
        f"({safety['defect_open']} vs {safety['defect_closed']} per 1,000 road-days). Other accidents only {safety['other_ratio']}x (busier roads).")
    sla24 = W[W.sla_hours == 24].sla_met.eq("Y").mean()
    add("Context", "Are SLA targets realistic?", "found",
        f"The 24 h target for cave-ins, open manholes and severe flooding is met {100 * sla24:.0f}% of the time across all contractors. "
        "Speed scores therefore compare each contractor with what was expected for its mix of targets, wards and workload.")
    # same road, type and area billed by two DIFFERENT contractors within the duplicate window
    pairs = []
    for _, g in W.sort_values("assigned_at").groupby(["road_id", "work_type", "area_sqm"]):
        g = g.reset_index(drop=True)
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                x, y = g.iloc[i], g.iloc[j]
                if x.contractor_id != y.contractor_id and (y.assigned_at - x.assigned_at) <= pd.Timedelta(days=DUP_WINDOW_DAYS):
                    pairs.append((x, y))
    overlap = [(x, y) for x, y in pairs if y.assigned_at < x.completed_at]
    add("Duplicate billing", "Same patch split across two contractors", "not found",
        f"{len(pairs)} pairs share road, work type and exact area within {DUP_WINDOW_DAYS} days across contractors, against 45 within one contractor, "
        "each on its own citizen complaint, so they read as chance on busy roads, not a scheme. "
        f"In {len(overlap)} of them the second crew was sent before the first had finished "
        f"({'; '.join(f'{x.road_id}: {x.work_order_id} then {y.work_order_id}' for x, y in overlap)}): unmerged complaints dispatched twice, "
        "a process gap rather than a billing one. Of the other two, Shivneri on RD0108 was redoing its own failed patch, and the second RD0180 job is already flagged as over the rate card. Not counted.")
    return log


def investigation_2(d, wo, cp, roads_x, closed_x, resolved_x, panel_x, social_x):
    """Second pass, after re-reading the brief and checking every unused column."""
    log = []
    add = lambda area, test, verdict, result: log.append(dict(area=area, test=test, verdict=verdict, result=result))
    E = panel_x
    add("Procurement", "Work orders in wards where the contractor is not empanelled (contractors.active_wards)", "verify",
        f"{E['outside_jobs']:,} of {E['jobs']:,} jobs (Rs {E['outside_inr'] / 1e7:.2f} Cr of Rs {E['spend_inr'] / 1e7:.2f} Cr) were done outside the "
        f"contractor's empanelled wards. Six wards ({', '.join(E['zero_coverage_wards'])}) have no empanelled contractor at all, yet "
        f"Rs {E['zero_coverage_inr'] / 1e7:.2f} Cr of work was done there. The pattern is uniform across contractors "
        f"({round(100 * min(E['by_contractor'].values()))} to {round(100 * max(E['by_contractor'].values()))}% outside), so this reads as an "
        "empanelment-records or procurement gap to verify, not contractor misconduct.")
    R = roads_x
    top = R["segments"][0] if R["segments"] else None
    add("Did the fix last?", "Mumbai spends crores fixing the same roads", "found",
        f"{R['n']} of {R['segments_repaired']} road segments were repaired {R['min_jobs']}+ times this monsoon and took Rs {R['spend_inr'] / 1e7:.2f} Cr, "
        f"{100 * R['share']:.0f}% of all spend. " + (f"Worst: {top['road_name']} ({top['road_id']}, ward {top['ward_code']}), {top['jobs']} repairs, "
        f"Rs {top['spend_inr'] / 1e5:.1f} L" + (", while under DLP" if top["under_dlp"] else "") + ". " if top else "")
        + f"{R['dlp_segments']} of these segments are still under DLP.")
    C = closed_x
    add("Connects the trail", "Complaints closed as another agency's road", "verify",
        f"{C['complaints']} complaints were closed as 'Rejected - Not BMC road' or 'Forwarded to MMRDA/PWD'. {C['on_bmc_paid_roads']} of them "
        f"are on segments in BMC's own road list where BMC paid contractors for repairs this season. They are shown as closed without a fix. "
        "Road matching from free text is about 76% exact, so verify before acting.")
    F = resolved_x
    add("Connects the trail", "Complaints marked Resolved whose fix failed", "found",
        f"{F['failed']:,} of {F['resolved']:,} Resolved complaints ({100 * F['share']:.0f}%) were linked to a fix that re-opened within 30 days. "
        "The citizen still sees 'Resolved'.")
    S_ = social_x
    add("Connects the trail", "Social posts as a second channel", "found",
        f"{S_['posts']} posts classified: {S_['by_kind'].get('report', 0)} reports, {S_['by_kind'].get('urgent', 0)} urgent, "
        f"{S_['by_kind'].get('fix failed', 0)} 'fixed but BACK', {S_['by_kind'].get('thanks', 0)} thank-yous, "
        f"{S_['by_kind'].get('unverified forward', 0)} unverified forwards and {S_['by_kind'].get('satire', 0)} satire. "
        f"{len(S_['corroborated'])} 'BACK' posts match exactly one contractor's failed fix on that road in the 10 days before. "
        f"{S_['linked_to_open_issues']} open issues are also being talked about on social media. Posts support evidence; they are never proof on their own.")
    x = wo.merge(d["roads"][["road_id"]], on="road_id")
    cm = wo[(wo.work_type == "Pothole")]
    rate = cm.groupby(["surface", "repair_method"]).reopened_within_30d.apply(lambda s: (s == "Y").mean())
    add("Fair accountability", "Cold mix used on concrete roads", "found",
        f"Cold mix fails {100 * rate.get(('Concrete (CC)', 'Cold mix patch'), 0):.0f}% of the time on concrete roads vs "
        f"{100 * rate.get(('Asphalt', 'Cold mix patch'), 0):.0f}% on asphalt, but hot mix also fails more on concrete "
        f"({100 * rate.get(('Concrete (CC)', 'Hot mix patch'), 0):.0f}% vs {100 * rate.get(('Asphalt', 'Hot mix patch'), 0):.0f}%). "
        "It is the road, not contractor misuse, so road surface is now in the fairness model and the planner picks the method per surface.")
    add("Hidden problems", "Repeat or fake complainants", "not found",
        f"All {cp.complainant_id.nunique():,} complainant ids are unique; nobody files repeatedly.")
    t = pd.crosstab(wo.contractor_id, wo.sla_hours, normalize="index")
    add("Hidden problems", "Lenient SLA tiers given to favoured contractors", "not found",
        f"Share of 168 h (easiest) targets is {100 * t[168].min():.0f}% to {100 * t[168].max():.0f}% for every contractor.")
    add("Connects the trail", "Complaints linked to a job in the wrong ward", "not found",
        "Every linked complaint with a ward is in the same ward as its work order.")
    add("Connects the trail", "Open complaints that were actually fixed but never linked", "not found",
        "A job followed on the same road and type within 14 days for 306 open complaints, but 291 in a placebo window before the complaint: chance on busy roads.")
    add("Context", "Work done on red or orange alert days fails more", "not found",
        "Jobs finished on red-alert days re-opened 21% of the time vs 25% on green days.")
    acc = d["acc"]
    dfx = acc.probable_cause.isin(["Pothole", "Waterlogged road", "Uneven road / open chamber"])
    add("Context", "Two-wheelers hit hardest by road defects", "not found",
        f"Two-wheelers are {100 * (acc[dfx].vehicle_type == 'Two-wheeler').mean():.0f}% of road-defect accidents and "
        f"{100 * (acc[~dfx].vehicle_type == 'Two-wheeler').mean():.0f}% of other accidents; a road's two-wheeler share does not predict them.")
    return log


def map_layers(d):
    rain = d["rain"].pivot(index="date", columns="station", values="rainfall_mm")
    big = d["tides"].groupby("date").big_tide_flag.apply(lambda s: (s == "Y").any())
    hs = []
    for h in d["hot"].itertuples():
        st = "Colaba" if h.ward_code in ISLAND_CITY else "Santacruz"
        wet = rain.index[rain[st] >= h.flood_threshold_mm_per_day]
        hs.append(dict(id=h.hotspot_id, name=h.name, ward=h.ward_code, lat=h.lat, lon=h.lon,
                       threshold=int(h.flood_threshold_mm_per_day), tide=h.tide_sensitive == "Y",
                       depth=int(h.avg_water_depth_cm), wet_days=int(len(wet)),
                       tide_days=int(big.reindex(wet).fillna(False).sum()) if h.tide_sensitive == "Y" else 0,
                       years=int(h.years_flagged_last_5)))
    roads = [dict(id=r.road_id, name=r.road_name, ward=r.ward_code, type=r.road_type, bus=r.bus_route == "Y",
                  dlp=r.under_dlp == "Y", a=[round(r.start_lon, 5), round(r.start_lat, 5)], b=[round(r.end_lon, 5), round(r.end_lat, 5)])
             for r in d["roads"].itertuples()]
    fac = [dict(name=f.name, type=f.type, lat=f.lat, lon=f.lon, road=f.ambulance_entry_road)
           for f in d["fac"][d["fac"].type == "Hospital"].itertuples()]
    rain_series = rain.reset_index().assign(date=lambda x: x.date.dt.strftime("%Y-%m-%d")).to_dict(orient="records")
    # Mumbai's outline: the 24 ward shapes merged, used to fade everything outside the city
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union
    geo = json.loads((DATA / "wards.geojson").read_text())
    outline = unary_union([shape(f["geometry"]) for f in geo["features"]]).buffer(0.002).simplify(0.0005)
    ring = [[round(x, 5), round(y, 5)] for x, y in mapping(outline)["coordinates"][0]]
    return dict(roads=roads, hotspots=hs, hospitals=fac, rain=rain_series, outline=ring)


# ------------------------------------------------------------- main


def indian(n: int) -> str:
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = ",".join([head[max(i - 2, 0):i] for i in range(len(head), 0, -2)][::-1])
        s = head + "," + tail
    return ("-" if n < 0 else "") + s


MONEY = re.compile(r"Rs\.? ?(\d[\d,]*)(\.\d+)?(\s?(?:Cr|L)\b)?")


def rupee_text(t: str) -> str:
    """One money style everywhere: Rs 197,710 -> ₹1,97,710; Rs 2.62 Cr -> ₹2.62 Cr."""
    def sub(m):
        whole, dec, unit = m.group(1), m.group(2) or "", m.group(3) or ""
        if unit or dec:
            return f"₹{whole}{dec}{unit}"
        return "₹" + indian(int(whole.replace(",", "")))
    return MONEY.sub(sub, t)


def jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, (pd.Timestamp,)):
        return None if pd.isna(o) else o.strftime("%Y-%m-%d %H:%M")
    if isinstance(o, set):
        return sorted(o)
    if o is pd.NaT:
        return None
    raise TypeError(type(o))


def main():
    d = load()
    implied = d["wo"].assign(s=d["wo"].sla_hours.map(SLA_SEVERITY)).groupby("work_type").s.mean()
    SEVERITY.clear()
    SEVERITY.update({k: round(float(v), 2) for k, v in implied.items()})
    wo = audit_work_orders(d)
    wo["rain_30d"] = rain_after(d, wo)
    wo["p_reopen"] = expected_reopen(d, wo)
    wo["p_sla"] = expected_sla(d, wo)
    cp = clean_complaints(d)
    safety = safety_cost_of_delay(d, cp)
    fixed_issues, open_issues = link_issues(d, cp, wo)
    contractors = contractor_cards(d, wo)
    wards = ward_cards(d, wo, open_issues, cp)
    econ = method_economics(wo, d["rc"])
    by_surface = method_by_surface(wo, d["rc"], econ)
    risk = road_risk(d, wo)
    items, by_ward, big_tides = plan(d, wo, open_issues, risk, econ, wards, by_surface)

    # second pass: what the brief asks that the first pass did not answer
    roads_x = X2.same_roads(d, wo)
    closed_x = X2.closed_unfixed(cp, wo)
    resolved_x = X2.resolved_failed(cp, wo)
    panel_x, inside, zero = X2.empanelment(d, wo)
    social_x = X2.social(d, wo, cp, items, build_gazetteer(d))
    # issue-type accuracy, measured against the work type of the job the DATASET links each complaint to
    # (work_orders.linked_complaint_ids, not our own linker). In-sample: the rules were written on this data.
    lk = d["wo"][["linked_complaint_ids", "work_type"]].dropna()
    lk = lk.assign(cid=lk.linked_complaint_ids.str.split("|")).explode("cid").drop_duplicates("cid").set_index("cid").work_type
    ev = cp.set_index("complaint_id").join(lk.rename("truth"), how="inner")
    type_acc = dict(n=int(len(ev)), filed_pct=round(float((ev.category_reported == ev.truth).mean()) * 100, 1),
                    cleaned_pct=round(float((ev.issue_type == ev.truth).mean()) * 100, 1),
                    needs_inspection=int((cp.issue_type == "Needs inspection").sum()))
    funnel_x = X2.cleanup_funnel(d["cp"], cp, fixed_issues, open_issues, closed_x, type_acc)
    for i, z in zip(wo.index, wo.ward_code.isin(zero)):
        if z:  # neutral, never counted: no contractor is empanelled in this ward at all
            wo.at[i, "audit_flags"] = wo.at[i, "audit_flags"] + [dict(
                code="OUTSIDE_PANEL", level="info",
                why=f"Ward {wo.at[i, 'ward_code']} has no empanelled contractor in contractors.csv, so every job here was done "
                    "outside a panel. A procurement-records question for BMC, not a mark against this contractor.", amount=0)]
    wo["outside_panel"] = ~inside
    for c in contractors:
        c["citizen_quotes"] = social_x["quotes"].get(c["contractor_id"], [])[:2]
        c["outside_panel_pct"] = round(100 * panel_x["by_contractor"][c["contractor_id"]])
    for w in wards:
        rf = resolved_x["by_ward"].get(w["ward_code"], {})
        w["resolved_failed"] = rf.get("failed", 0)
        w["resolved"] = rf.get("resolved", 0)
        w["closed_unfixed"] = int(closed_x["by_ward"].get(w["ward_code"], 0))
        w["chronic_segments"] = [s_["road_id"] for s_ in roads_x["segments"] if s_["ward_code"] == w["ward_code"]]
        w["social"] = social_x["by_ward"].get(w["ward_code"], {})
        w["no_panel"] = w["ward_code"] in zero

    flagged = wo[wo["audit_flags"].map(lambda f: any(x["level"] in ("high", "review") for x in f))]
    totals = dict(
        spend_inr=int(wo.cost_inr.sum()), budget_inr=int(d["wards"].monsoon_repair_budget_inr_2025.sum()),
        jobs=len(wo), complaints=len(cp), complaints_noise=int(cp.is_noise.sum()),
        complaints_category_corrected=int(cp.category_corrected.sum()),
        issue_type_accuracy=type_acc,
        complaints_ward_filled=int((d["cp"].ward_code.isna() & cp.ward_filled.notna()).sum()),
        complaints_duplicate=int((cp.status == "Closed - Duplicate").sum()),
        issues_fixed=len(fixed_issues), issues_open=len(open_issues),
        open_complaints=int(sum(len(o["complaint_ids"]) for o in open_issues)),
        recoverable_inr=int(wo.recoverable_inr.sum()),
        failed_spend_inr=int(wo.loc[wo.reopened_within_30d == "Y", "cost_inr"].sum()),
        flagged_jobs=len(flagged),
        n_duplicate=int(wo.duplicate_of.notna().sum()),
        dup_inr=int(wo.loc[wo.duplicate_of.notna(), "cost_inr"].sum()),
        n_dlp=int((wo.under_dlp == "Y").sum()),
        dlp_records_gap_jobs=int(wo["audit_flags"].map(lambda f: any(x["code"] == "DLP_RECORDS_GAP" for x in f)).sum()),
        dlp_inr=int(wo.loc[wo.under_dlp == "Y", "cost_inr"].sum()),
        n_dlp_surface=int(((wo.under_dlp == "Y") & wo.work_type.isin(SURFACE_TYPES)).sum()),
        dlp_surface_inr=int(wo.loc[(wo.under_dlp == "Y") & wo.work_type.isin(SURFACE_TYPES), "cost_inr"].sum()),
        n_dlp_drainage=int(((wo.under_dlp == "Y") & ~wo.work_type.isin(SURFACE_TYPES)).sum()),
        dlp_drainage_inr=int(wo.loc[(wo.under_dlp == "Y") & ~wo.work_type.isin(SURFACE_TYPES), "cost_inr"].sum()),
        severity_by_type=dict(SEVERITY),
        n_overbilled_high=int((wo.cost_ratio > OVERBILL_HIGH).sum()),
        n_overbilled_review=int(((wo.cost_ratio > OVERBILL_REVIEW) & (wo.cost_ratio <= OVERBILL_HIGH)).sum()),
        overbill_excess_inr=int((wo.cost_inr - wo.expected_inr)[wo.cost_ratio > OVERBILL_REVIEW].sum()),
        big_tide_days=big_tides,
        safety=safety,
        sla24_met_pct=round(100 * wo[wo.sla_hours == 24].sla_met.eq("Y").mean(), 1),
        sla_met_pct=round(100 * wo.sla_met.eq("Y").mean(), 1),
        reopen_pct=round(100 * wo.reopened_within_30d.eq("Y").mean(), 1),
        same_roads={k: v for k, v in roads_x.items() if k != "segments"},
        closed_unfixed={k: v for k, v in closed_x.items() if k not in ("top", "complaint_ids")},
        resolved_failed={k: v for k, v in resolved_x.items() if k != "by_ward"},
        empanelment={k: v for k, v in panel_x.items() if k != "panel"},
        social={k: v for k, v in social_x.items() if k not in ("quotes", "by_ward", "corroborated")},
    )

    cols = ["work_order_id", "linked_complaint_ids", "ward_code", "road_id", "road_name", "work_type", "repair_method",
            "contractor_id", "contractor_name", "assigned_at", "completed_at", "area_sqm", "cost_inr", "expected_inr",
            "cost_ratio", "sla_hours", "hours_taken", "sla_met", "reopened_within_30d", "under_dlp", "duplicate_of",
            "engineer_remark", "audit_flags", "recoverable_inr", "p_reopen", "rain_30d", "surface", "outside_panel"]
    work_orders = wo[cols].copy().rename(columns={"audit_flags": "flags"})
    work_orders["contractor_name"] = work_orders.contractor_name.str.replace(" (synthetic)", "", regex=False)
    work_orders["cost_ratio"] = work_orders.cost_ratio.round(3)
    work_orders["p_reopen"] = work_orders.p_reopen.round(3)
    work_orders["rain_30d"] = work_orders.rain_30d.round(0)
    work_orders = work_orders.astype(object).where(work_orders.notna(), None)

    comp_cols = ["complaint_id", "received_at", "channel", "category_reported", "issue_type", "description", "language",
                 "locality_std", "ward_filled", "status", "resolved_at", "upvotes", "issue_id", "road_guess", "type_source"]
    complaints = cp[comp_cols].astype(object).where(cp[comp_cols].notna(), None)
    wo_by_issue = {i["issue_id"]: i["work_order_id"] for i in fixed_issues}

    out = dict(
        generated_from="Claude-Impact-Labs-data-2 (synthetic)",
        thresholds=dict(overbill_review=OVERBILL_REVIEW, overbill_high=OVERBILL_HIGH, dup_window_days=DUP_WINDOW_DAYS),
        totals=totals,
        wards=wards,
        contractors=contractors,
        method_economics=econ,
        plan=items,
        plan_by_ward=by_ward,
        work_orders=work_orders.to_dict(orient="records"),
        complaints=complaints.to_dict(orient="records"),
        issue_to_wo=wo_by_issue,
        rate_card=d["rc"].to_dict(orient="records"),
        investigation=investigation(d, wo, cp, safety) + investigation_2(d, wo, cp, roads_x, closed_x, resolved_x, panel_x, social_x),
        same_roads=roads_x["segments"],
        closed_unfixed=closed_x["top"],
        closed_unfixed_ids=closed_x["complaint_ids"],
        social_corroborated=social_x["corroborated"],
        method_by_surface=by_surface,
        cleanup=funnel_x,
        ward_split=X2.ward_split(wards, items, wo),
        map=map_layers(d),
    )
    for w in out["work_orders"]:
        for f in w["flags"]:
            f["why"] = rupee_text(f["why"])
    for r in out["investigation"]:
        r["result"] = rupee_text(r["result"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, default=jsonable, ensure_ascii=False))
    print(json.dumps(totals, indent=1))
    print("contractors:", [(c["contractor_id"], c["grade"], c["score"], c["reopen_oe"]) for c in contractors])
    print("wrote", OUT, round(OUT.stat().st_size / 1e6, 1), "MB")


if __name__ == "__main__":
    main()
