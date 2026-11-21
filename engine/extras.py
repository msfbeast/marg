"""Second-pass analyses added after a full re-read of the brief.

  same_roads        "Mumbai spends crores fixing the same roads": segments
                    repaired again and again in one monsoon
  closed_unfixed    complaints closed as another agency's road although BMC
                    repairs that segment itself
  resolved_failed   complaints marked Resolved whose fix failed in 30 days
  empanelment       jobs outside the contractor's empanelled wards
  social            650 posts classified, located, and linked to failed jobs
                    and open issues (never used as proof on their own)
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

SURFACE_TYPES = ("Pothole", "Broken paver blocks", "Road cave-in")


# ------------------------------------------------------------ same roads

def same_roads(d, wo, min_jobs=15):
    rd = d["roads"].set_index("road_id")
    g = wo.groupby("road_id")
    seg = pd.DataFrame({
        "jobs": g.size(), "spend": g.cost_inr.sum(),
        "failed": g.reopened_within_30d.apply(lambda s: int((s == "Y").sum())),
        "patches": g.work_type.apply(lambda s: int((s == "Pothole").sum())),
        "resurface_remark": g.engineer_remark.apply(lambda s: int((s == "Patched, needs resurfacing after monsoon").sum())),
    })
    seg = seg.join(rd[["road_name", "ward_code", "road_type", "surface", "under_dlp", "length_m", "last_resurfaced"]])
    seg = seg.sort_values("spend", ascending=False)
    chronic = seg[seg.jobs >= min_jobs]
    total = float(wo.cost_inr.sum())
    rows = []
    for rid, r in chronic.iterrows():
        jobs = wo[wo.road_id == rid].sort_values("assigned_at")
        ct = jobs.groupby("contractor_name").cost_inr.agg(["size", "sum"]).sort_values("sum", ascending=False)
        rows.append(dict(
            road_id=rid, road_name=r.road_name, ward_code=r.ward_code, road_type=r.road_type, surface=r.surface,
            under_dlp=r.under_dlp == "Y", jobs=int(r.jobs), spend_inr=int(r.spend), failed=int(r.failed),
            patches=int(r.patches), resurface_remark=int(r.resurface_remark), length_m=int(r.length_m),
            last_resurfaced=str(r.last_resurfaced)[:10],
            per_week=round(r.jobs / 18, 1),
            contractors=[dict(name=n.replace(" (synthetic)", ""), jobs=int(v["size"]), spend_inr=int(v["sum"])) for n, v in ct.iterrows()],
            work_orders=jobs.work_order_id.tolist(),
            by_type=jobs.work_type.value_counts().to_dict(),
        ))
    top10 = seg.head(max(1, round(len(seg) * 0.1)))
    return dict(
        min_jobs=min_jobs, segments=rows, n=len(rows), spend_inr=int(chronic.spend.sum()), jobs=int(chronic.jobs.sum()),
        share=round(float(chronic.spend.sum()) / total, 3), segments_repaired=int(len(seg)),
        top10pct_share=round(float(top10.spend.sum()) / total, 3), dlp_segments=int((chronic.under_dlp == "Y").sum()),
        dlp_spend_inr=int(chronic[chronic.under_dlp == "Y"].spend.sum()),
        never_repaired=sorted(set(d["roads"].road_id) - set(wo.road_id)),
    )


# ------------------------------------------------- complaints closed, not fixed

CLOSED_ELSEWHERE = ("Rejected - Not BMC road", "Forwarded to MMRDA/PWD")


def closed_unfixed(cp, wo):
    paid = set(wo.road_id)
    k = cp[cp.status.isin(CLOSED_ELSEWHERE) & ~cp.is_noise].copy()
    k["bmc_paid_road"] = k.road_guess.isin(paid)
    hit = k[k.bmc_paid_road]
    spend_on = wo[wo.road_id.isin(hit.road_guess)].groupby("road_id").cost_inr.sum()
    issues = []
    for (ward, road, typ), g in hit.groupby(["ward_filled", "road_guess", "issue_type"]):
        issues.append(dict(ward_code=ward, road_id=road, issue_type=typ, complaints=len(g), complaint_ids=g.complaint_id.tolist(),
                           statuses=g.status.value_counts().to_dict(), first=str(g.received_at.min())[:16],
                           bmc_spend_on_road_inr=int(spend_on.get(road, 0))))
    issues.sort(key=lambda x: -x["complaints"])
    return dict(
        complaints=int(len(k)), on_bmc_paid_roads=int(len(hit)), issues=len(issues),
        by_status=k.status.value_counts().to_dict(),
        by_ward=hit.groupby("ward_filled").size().astype(int).to_dict(),
        complaint_ids=hit.complaint_id.tolist(), top=issues[:60],
    )


# ------------------------------------------------- resolved, then failed

def resolved_failed(cp, wo):
    fail = {}
    for r in wo.itertuples():
        if isinstance(r.linked_complaint_ids, str):
            for c in r.linked_complaint_ids.split("|"):
                fail[c] = r.reopened_within_30d == "Y"
    res = cp[cp.status == "Resolved"].copy()
    res["failed"] = res.complaint_id.map(fail).fillna(False)
    by = res.groupby("ward_filled").failed.agg(["sum", "size"])
    return dict(resolved=int(len(res)), failed=int(res.failed.sum()), share=round(float(res.failed.mean()), 3),
                by_ward={w: dict(failed=int(v["sum"]), resolved=int(v["size"])) for w, v in by.iterrows()})


# ------------------------------------------------- empanelment

def empanelment(d, wo):
    aw = {r.contractor_id: {x.strip() for x in r.active_wards.split(";")} for r in d["ct"].itertuples()}
    inside = np.array([w in aw[c] for w, c in zip(wo.ward_code, wo.contractor_id)])
    covered = set().union(*aw.values())
    zero = sorted(set(d["wards"].ward_code) - covered)
    z = wo.ward_code.isin(zero)
    return dict(
        outside_jobs=int((~inside).sum()), outside_inr=int(wo.cost_inr[~inside].sum()), jobs=len(wo), spend_inr=int(wo.cost_inr.sum()),
        zero_coverage_wards=zero, zero_coverage_jobs=int(z.sum()), zero_coverage_inr=int(wo.cost_inr[z].sum()),
        by_contractor={c: round(float(1 - inside[wo.contractor_id.values == c].mean()), 2) for c in sorted(aw)},
        panel={c: sorted(v) for c, v in aw.items()},
    ), inside, zero


# ------------------------------------------------- social posts

POST_KINDS = [  # (kind, issue type or None, regex); first match wins
    ("unverified forward", "Waterlogging", r"as received:|\(unverified\)"),
    ("fix failed", "Pothole", r"is BACK on"),
    ("thanks", "Pothole", r"thank you for fixing"),
    ("urgent", "Waterlogging", r"stuck near .*till knee|URGENT"),
    ("incident", "Pothole", r"bike wala gira"),
    ("satire", "Waterlogging", r"swimming pool"),
    ("report", "Road cave-in", r"dhas gaya"),
    ("report", "Open or broken manhole", r"open manhole"),
    ("report", "Choked drain / nullah overflow", r"gutter overflow"),
    ("report", "Pothole", r"khadde|खड्डे|gaddha"),
    ("report", "Waterlogging", r"totally flooded|paani bhar gaya"),
    ("chatter", "Waterlogging", r"school band|morning group"),
]


def classify_post(text):
    for kind, typ, pat in POST_KINDS:
        if re.search(pat, text, re.I):
            return kind, typ
    return "other", None


def social(d, wo, cp, plan_items, gaz):
    sp = d["social"].copy()
    rd = d["roads"]
    names = sorted(rd.road_name.unique(), key=len, reverse=True)
    kinds = [classify_post(t) for t in sp.text]
    sp["kind"] = [k for k, _ in kinds]
    sp["issue_type"] = [t for _, t in kinds]
    road, loc, ward = [], [], []
    for t in sp.text:
        low = t.lower()
        name = next((n for n in names if n.lower() in low), None)
        g = next((x for x in gaz if x[0] in low), None)
        road.append(name)
        loc.append(g[1] if g else None)
        ward.append(g[2] if g else (rd[rd.road_name == name].ward_code.iloc[0] if name else None))
    sp["road_name"], sp["locality"], sp["ward_code"] = road, loc, ward

    # 1. "Just fixed last week and pothole is BACK on <road>" -> a failed pothole fix on that road 2 to 10 days
    #    before the post, by exactly one contractor. Anything ambiguous is left unlinked.
    quotes, corroborated = {}, []
    for r in sp[sp.kind == "fix failed"].itertuples():
        if not r.road_name:
            continue
        ids = rd[rd.road_name == r.road_name].road_id
        w = wo[wo.road_id.isin(ids) & (wo.work_type == "Pothole") & (wo.reopened_within_30d == "Y")
               & (wo.completed_at <= r.posted_at - pd.Timedelta(days=2)) & (wo.completed_at >= r.posted_at - pd.Timedelta(days=10))]
        if w.contractor_id.nunique() == 1:  # unambiguous: only one contractor's failed fix fits
            j = w.sort_values("completed_at").iloc[-1]
            days = (r.posted_at - j.completed_at).days
            item = dict(post_id=r.post_id, posted_at=str(r.posted_at)[:10], source=r.source, text=r.text,
                        road_name=r.road_name, work_order_id=j.work_order_id, contractor_id=j.contractor_id, days_after=int(days))
            corroborated.append(item)
            quotes.setdefault(j.contractor_id, []).append(item)

    # 2. reports and urgent posts -> open issues in the same ward, on the same road or locality, same type
    by_issue = {}
    sig = sp[sp.kind.isin(["report", "urgent", "incident"])]
    for it in plan_items:
        m = sig[(sig.ward_code == it["ward_code"]) & (sig.issue_type == it["issue_type"])
                & ((sig.road_name == it["road_name"]) | (sig.locality == it["locality"]))]
        m = m[m.posted_at >= pd.Timestamp(it["first_reported"]) - pd.Timedelta(days=3)]
        if len(m):
            by_issue[it["issue_id"]] = [dict(post_id=p.post_id, posted_at=str(p.posted_at)[:16], source=p.source, kind=p.kind,
                                             text=p.text, likes=int(p.likes_or_forwards)) for p in m.itertuples()][:4]
            it["social"] = by_issue[it["issue_id"]]
            it["social_count"] = int(len(m))

    # 3. reports with no complaint at all in that ward and type within 7 days (seen only on social media)
    c = cp[~cp.is_noise]
    unreported = 0
    for p in sig.itertuples():
        if not p.ward_code:
            continue
        near = c[(c.ward_filled == p.ward_code) & (c.issue_type == p.issue_type)
                 & ((c.received_at - p.posted_at).abs() <= pd.Timedelta(days=7))]
        unreported += len(near) == 0

    per_ward = sp[sp.ward_code.notna()].groupby(["ward_code", "kind"]).size().unstack(fill_value=0)
    return dict(
        posts=int(len(sp)), by_kind=sp.kind.value_counts().astype(int).to_dict(), located=int(sp.ward_code.notna().sum()),
        corroborated=corroborated, quotes=quotes, linked_to_open_issues=len(by_issue),
        posts_on_open_issues=int(sum(it.get("social_count", 0) for it in plan_items)), unreported=int(unreported), signal_posts=int(len(sig)),
        by_ward={w: {k: int(v) for k, v in row.items() if v} for w, row in per_ward.iterrows()},
    )


# ------------------------------------------------- complaint clean-up funnel

def cleanup_funnel(raw_cp, cp, fixed_issues, open_issues, closed_x, acc):
    """How 6,501 messy complaints become clean issues, with one real example
    of a complaint that needed every repair step."""
    statuses = cp.status.value_counts()
    steps = [
        dict(label="Complaints received", n=int(len(cp)), note="App, 1916 helpline, web portal and walk-ins, in 4 languages"),
        dict(label="Noise dropped", n=int(cp.is_noise.sum()), note="'Test' entries and non-road issues", minus=True),
        dict(label="Wards filled in", n=int((raw_cp.ward_code.isna() & cp.ward_filled.notna()).sum()), note="From locality names and Devanagari aliases, 98.5% right"),
        dict(label="Categories corrected", n=int(cp.category_corrected.sum()), note=f"From the photo or English text. Checked on {acc['n']:,} complaints the data links to a job: {acc['cleaned_pct']:.0f}% match the job vs {acc['filed_pct']:.0f}% as filed. {acc['needs_inspection']} with no evidence sent to inspection, not guessed"),
        dict(label="Duplicates merged", n=int(statuses.get("Closed - Duplicate", 0)), note="Same problem reported again or on another channel"),
        dict(label="Issues fixed by a work order", n=len(fixed_issues), note="Each linked to its job, contractor, bill and outcome"),
        dict(label="Issues never fixed", n=len(open_issues), note="Open or in progress, ranked by risk in Next rupee"),
        dict(label="Closed without a fix", n=int(closed_x["issues"]), note="Closed as another agency's road, on roads BMC repairs"),
    ]
    raw = raw_cp.set_index("complaint_id")
    pick = cp[raw_cp.ward_code.isna().values & cp.category_corrected & cp.issue_id.notna()
              & cp.language.isin(["hi-en", "mr", "hi"]) & (cp.status == "Closed - Duplicate")]
    if not len(pick):
        pick = cp[raw_cp.ward_code.isna().values & cp.category_corrected & cp.issue_id.notna()]
    ex = None
    if len(pick):
        c = pick.iloc[0]
        r = raw.loc[c.complaint_id]
        ex = dict(complaint_id=c.complaint_id, description=c.description, language=c.language, channel=c.channel,
                  raw_category=r.category_reported, raw_ward=None if pd.isna(r.ward_code) else r.ward_code, raw_locality=r.locality_text,
                  photo=None if pd.isna(r.photo_description) else r.photo_description,
                  issue_type=c.issue_type, type_source=c.type_source, ward=c.ward_filled, locality=c.locality_std,
                  status=c.status, issue_id=c.issue_id)
    return dict(steps=steps, example=ex)


# ------------------------------------------------- next season, across wards

def ward_split(wards, plan_items, wo):
    """Split next season's money across wards by need, not by last year's
    habit. Need = what the ward's 2025 work should have cost (spend minus
    money to question) plus the durable cost of its never-fixed backlog.
    DLP fixes are excluded: the original contractor pays for those."""
    total = sum(w["budget_inr"] for w in wards)
    backlog = {}
    for p in plan_items:
        backlog[p["ward_code"]] = backlog.get(p["ward_code"], 0) + p["est_cost_inr"]
    rows = []
    for w in wards:
        clean = w["spend_inr"] - w["recoverable_inr"]
        need = clean + backlog.get(w["ward_code"], 0)
        rows.append(dict(ward_code=w["ward_code"], ward_name=w["ward_name"], budget_2025=w["budget_inr"],
                         clean_spend=int(clean), backlog=int(backlog.get(w["ward_code"], 0)), need=int(need)))
    s = sum(r["need"] for r in rows)
    for r in rows:
        r["suggested"] = int(round(total * r["need"] / s / 10000) * 10000)
        r["change"] = r["suggested"] - r["budget_2025"]
        r["change_pct"] = round(100 * r["change"] / r["budget_2025"], 1)
    rows.sort(key=lambda r: -r["change_pct"])
    return dict(total=total, rows=rows)
