"""MARG web server.

Serves the static UI and data.json, and runs the Claude assistant.
Claude never sees raw CSVs: it calls tools over the audited data, so every
answer is grounded in work order ids and the engine's arithmetic.

Run:  .venv/bin/python app/server.py   (port 3230; reads ANTHROPIC_API_KEY from .env)

Cost plan (same idea as AgentOS: cheapest model that does the job, never Opus):
  - Chat lookups ("what happened to my complaint", "show flags in K/W") run on
    Claude Haiku 5.5. Questions that need judgement (why, compare, fair,
    recommend, plan) go to Claude Sonnet 5.5. Haiku escalates to Sonnet if it
    runs out of steps or comes back empty.
  - Ward one-pagers and contractor scorecards are written once by Sonnet from
    data passed inline (one call, no tool loop) and cached to narratives.json.
    engine/prewarm.py writes all 32 through the Batch API at half price.
  - Every call is logged to usage.jsonl with its cost; a daily cap
    (MONSOON_DAILY_USD, default 2) stops new calls when reached.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
ENV = HERE.parent / ".env"
if ENV.exists():
    for line in ENV.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
DATA = json.loads((HERE / "data.json").read_text())
# Writable state. Locally: next to this file. On Vercel the disk is read-only except /tmp,
# so state lives there, seeded from the shipped files on first use.
ON_VERCEL = bool(os.environ.get("VERCEL"))
STATE = Path(os.environ.get("MONSOON_STATE_DIR") or ("/tmp/marg" if ON_VERCEL else HERE))
STATE.mkdir(parents=True, exist_ok=True)


def state_file(name):
    p = STATE / name
    if STATE != HERE and not p.exists() and (HERE / name).exists():
        p.write_bytes((HERE / name).read_bytes())
    return p


CACHE_PATH = state_file("narratives.json")
CACHE = json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else {}
HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"
# USD per million tokens: input, output, cache read, cache write (5 min)
PRICE = {HAIKU: (0.10, 0.50, 0.01, 0.125), SONNET: (2.00, 10.00, 0.10, 2.50)}
DAILY_CAP = float(os.environ.get("MONSOON_DAILY_USD", "2"))
LEDGER = (STATE / "usage.jsonl") if STATE != HERE else (HERE.parent / "usage.jsonl")

WO = {w["work_order_id"]: w for w in DATA["work_orders"]}
CP = {c["complaint_id"]: c for c in DATA["complaints"]}
WARDS = {w["ward_code"]: w for w in DATA["wards"]}
CTS = {c["contractor_id"]: c for c in DATA["contractors"]}
PLAN = {p["issue_id"]: p for p in DATA["plan"]}

app = FastAPI()


def client():
    try:
        return anthropic.Anthropic()
    except Exception:
        return None


def slim_wo(w):
    return {k: w[k] for k in ("work_order_id", "linked_complaint_ids", "ward_code", "road_id", "road_name", "work_type",
                              "repair_method", "contractor_name", "assigned_at", "completed_at", "area_sqm", "cost_inr",
                              "expected_inr", "cost_ratio", "sla_hours", "hours_taken", "sla_met",
                              "reopened_within_30d", "under_dlp", "duplicate_of", "engineer_remark", "flags",
                              "recoverable_inr")}


# ------------------------------------------------------------------ tools

def t_complaint(complaint_id: str):
    c = CP.get(complaint_id.strip().upper())
    if not c:
        return {"error": f"No complaint {complaint_id}. Ids look like BMC25-000123."}
    out = {"complaint": c}
    iid = c.get("issue_id")
    if iid and iid in DATA["issue_to_wo"]:
        out["work_order"] = slim_wo(WO[DATA["issue_to_wo"][iid]])
    elif iid and iid in PLAN:
        out["open_issue"] = PLAN[iid]
    return out


def t_work_order(work_order_id: str):
    w = WO.get(work_order_id.strip().upper())
    return slim_wo(w) if w else {"error": f"No work order {work_order_id}."}


def t_ward(ward_code: str):
    w = WARDS.get(ward_code.strip().upper())
    if not w:
        return {"error": f"No ward {ward_code}. Codes: {', '.join(WARDS)}"}
    flagged = [slim_wo(WO[i]) for i in WO if WO[i]["ward_code"] == w["ward_code"]
               and any(f["level"] in ("high", "review") for f in WO[i]["flags"])]
    flagged.sort(key=lambda x: -x["recoverable_inr"])
    top = [{k: v for k, v in PLAN[i].items() if k != "social"} for i in DATA["plan_by_ward"][w["ward_code"]][:8]]
    code = w["ward_code"]
    same = [{k: s[k] for k in ("road_id", "road_name", "jobs", "spend_inr", "failed", "under_dlp", "surface", "resurface_remark")}
            for s in DATA["same_roads"] if s["ward_code"] == code]
    closed = [{k: x[k] for k in ("road_id", "issue_type", "complaints", "statuses", "bmc_spend_on_road_inr")}
              for x in DATA["closed_unfixed"] if x["ward_code"] == code][:5]
    return {"ward": w, "top_flagged_work_orders": flagged[:12], "flagged_count": len(flagged), "next_rupee_top": top,
            "same_roads": same, "same_roads_rule": "segments repaired 15 or more times this monsoon",
            "closed_without_fix": {"complaints": w.get("closed_unfixed", 0), "top": closed,
                                   "note": "closed as 'Not BMC road' or forwarded to MMRDA/PWD, on segments BMC itself repairs; verify jurisdiction"},
            "resolved_but_failed": {"failed": w.get("resolved_failed", 0), "resolved": w.get("resolved", 0)},
            "no_empanelled_contractor": w.get("no_panel", False)}


def t_contractor(name_or_id: str):
    q = name_or_id.strip().lower()
    c = next((c for c in DATA["contractors"] if c["contractor_id"].lower() == q or q in c["name"].lower()), None)
    return c or {"error": f"No contractor matching {name_or_id}. Options: " + ", ".join(c["name"] for c in DATA["contractors"])}


def t_search_complaints(text: str, ward_code: str | None = None, limit: int = 8):
    q = text.lower()
    hits = [c for c in DATA["complaints"] if q in (c["description"] or "").lower() or q in (c["locality_std"] or "").lower()]
    if ward_code:
        hits = [c for c in hits if c["ward_filled"] == ward_code.upper()]
    return {"count": len(hits), "results": hits[:limit]}


def t_flags(code: str | None = None, ward_code: str | None = None, contractor: str | None = None, limit: int = 15):
    rows = [w for w in WO.values() if any(f["level"] in ("high", "review") for f in w["flags"])]
    if code:
        rows = [w for w in rows if any(f["code"] == code.upper() for f in w["flags"])]
    if ward_code:
        rows = [w for w in rows if w["ward_code"] == ward_code.upper()]
    if contractor:
        rows = [w for w in rows if contractor.lower() in w["contractor_name"].lower() or w["contractor_id"] == contractor.upper()]
    rows.sort(key=lambda w: -w["recoverable_inr"])
    return {"count": len(rows), "total_recoverable_inr": sum(w["recoverable_inr"] for w in rows),
            "results": [slim_wo(w) for w in rows[:limit]]}


def t_overview():
    return {"totals": DATA["totals"], "thresholds": DATA["thresholds"],
            "contractors": [{k: c[k] for k in ("name", "grade", "score", "reopen_pct", "expected_reopen_pct", "sla_met_pct",
                                                "overbilled_jobs", "duplicate_jobs", "recoverable_inr")} for c in DATA["contractors"]],
            "wards": [{k: w[k] for k in ("ward_code", "ward_name", "budget_inr", "spend_inr", "spend_pct", "recoverable_inr",
                                          "open_issues", "grade")} for w in DATA["wards"]],
            "method_economics": DATA["method_economics"]}


TOOLS = [
    dict(name="lookup_complaint", description="Trace one citizen complaint: its cleaned issue, the work order that fixed it (contractor, cost, SLA, whether it held) or, if never fixed, its risk rank.",
         input_schema={"type": "object", "properties": {"complaint_id": {"type": "string"}}, "required": ["complaint_id"]}),
    dict(name="lookup_work_order", description="Full audited record of one work order including flags and the evidence for each.",
         input_schema={"type": "object", "properties": {"work_order_id": {"type": "string"}}, "required": ["work_order_id"]}),
    dict(name="ward_report", description="A ward's budget vs spend, leakage, contractors, methods, flagged jobs and its top next-rupee priorities.",
         input_schema={"type": "object", "properties": {"ward_code": {"type": "string", "description": "e.g. L, F/N, K/W"}}, "required": ["ward_code"]}),
    dict(name="contractor_scorecard", description="A contractor's fair scorecard: SLA, observed vs expected re-open rate, billing flags, evidence ids.",
         input_schema={"type": "object", "properties": {"name_or_id": {"type": "string"}}, "required": ["name_or_id"]}),
    dict(name="search_complaints", description="Find complaints by free text or locality (English, Hindi, Marathi, Hinglish), optionally in one ward.",
         input_schema={"type": "object", "properties": {"text": {"type": "string"}, "ward_code": {"type": "string"}}, "required": ["text"]}),
    dict(name="list_flags", description="List audit flags (DUPLICATE, DLP_PAID, OVERBILLED) filtered by code, ward or contractor, largest recoverable first.",
         input_schema={"type": "object", "properties": {"code": {"type": "string"}, "ward_code": {"type": "string"}, "contractor": {"type": "string"}}}),
    dict(name="city_overview", description="City totals, every contractor and ward at a glance, and cost per durable fix by repair method.",
         input_schema={"type": "object", "properties": {}}),
]
IMPL = dict(lookup_complaint=t_complaint, lookup_work_order=t_work_order, ward_report=t_ward,
            contractor_scorecard=t_contractor, search_complaints=t_search_complaints, list_flags=t_flags,
            city_overview=t_overview)

SYSTEM = """You are MARG (Monsoon Audit of Road Guarantees), a public accountability assistant for Mumbai's monsoon road repairs (BMC wards A to T).
The data is synthetic and all contractors are fictional; say so if anyone asks about real firms.

How to answer:
- Use the tools for every fact. Quote work order ids (WO25-xxxxx) and complaint ids so a reader can check you.
- Amounts in rupees with Indian grouping (Rs 1,23,456) or lakh/crore. Plain words a citizen or corporator understands.
- Reply in the language the person wrote in (English, Hindi, Marathi or Hinglish).
- Be fair. A flag is a question to answer, not proof of fraud. Mention context the contractor does not control: low-lying ward, heavy rain after the job, busy roads. Never call anyone a thief or corrupt.
- Re-open rates: compare observed with expected (the engine models method, ward flood risk, rain and traffic). Observed far above expected is the signal, not the raw rate.
- Short answers: a few sentences or a tight list. No em dashes."""


def clean(text: str) -> str:
    """House style: no em dashes in anything shown under the user's name."""
    return text.replace(" \u2014 ", ", ").replace("\u2014", ", ")


def has_key():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def spent_today():
    if not LEDGER.exists():
        return 0.0
    today = time.strftime("%Y-%m-%d")
    total = 0.0
    for line in LEDGER.read_text().splitlines():
        r = json.loads(line)
        if r["day"] == today:
            total += r["usd"]
    return total


def log_usage(model, usage, route, batch=False):
    pin, pout, pread, pwrite = PRICE[model]
    u = usage
    read = getattr(u, "cache_read_input_tokens", 0) or 0
    write = getattr(u, "cache_creation_input_tokens", 0) or 0
    usd = (u.input_tokens * pin + u.output_tokens * pout + read * pread + write * pwrite) / 1e6
    if batch:
        usd /= 2
    rec = dict(day=time.strftime("%Y-%m-%d"), ts=time.time(), model=model, route=route, batch=batch,
               input=u.input_tokens, output=u.output_tokens, cache_read=read, cache_write=write, usd=round(usd, 6))
    with LEDGER.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    return usd


def guard():
    if not has_key():
        raise HTTPException(503, "Claude is not connected. Put ANTHROPIC_API_KEY in Monsoon/.env and restart the server.")
    if spent_today() >= DAILY_CAP:
        raise HTTPException(429, f"Today's Claude budget of ${DAILY_CAP:.2f} is used up. Raise MONSOON_DAILY_USD to continue.")


JUDGEMENT = re.compile(r"\b(why|compare|versus|vs|fair|unfair|recommend|should|plan|priorit|explain|worst|best|"
                       r"which .* (more|most|less|least)|kyun|kyon|kyu|kaise)\b|क्यों|कैसे|का म्हणून|कशामुळे|कसे", re.I)


def pick_model(question: str) -> str:
    """Lookups go to Haiku; anything asking for judgement goes to Sonnet."""
    q = question.strip()
    if JUDGEMENT.search(q) or len(q) > 160:
        return SONNET
    return HAIKU


def request_args(model, effort):
    args = dict(extra_body={"output_config": {"effort": effort}})
    if model == SONNET:
        # server-side refusal fallback, routed by category
        args["extra_body"]["fallbacks"] = "default"
        args["extra_headers"] = {"anthropic-beta": "server-side-fallback-2026-07-01"}
    return args


def run_claude(messages, model, route, max_turns=6, effort="low"):
    guard()
    c = anthropic.Anthropic()
    used = []
    for _ in range(max_turns):
        resp = c.messages.create(
            model=model, max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            tools=TOOLS, messages=messages, **request_args(model, effort),
        )
        log_usage(model, resp.usage, route)
        if resp.stop_reason == "refusal":
            return "I can't help with that one.", used, False
        if resp.stop_reason == "max_tokens":
            partial = "".join(b.text for b in resp.content if b.type == "text").strip()
            return clean(partial + "\n\n(Answer cut short. Ask a narrower question.)"), used, bool(partial)
        messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})
        if resp.stop_reason != "tool_use":
            text = clean("".join(b.text for b in resp.content if b.type == "text").strip())
            return text, used, bool(text)
        results = []
        for b in resp.content:
            if b.type != "tool_use":
                continue
            used.append({"tool": b.name, "input": b.input})
            try:
                out = IMPL[b.name](**(b.input or {}))
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out, ensure_ascii=False)[:24000]})
            except Exception as e:  # noqa: BLE001
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": f"error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    return "That took too many steps.", used, False


class Ask(BaseModel):
    question: str
    history: list[dict] = []


RATE = {}  # visitor ip -> recent call times (per-visitor limit so a public link can't drain the credits)
RATE_PER_HOUR = int(os.environ.get("MONSOON_CALLS_PER_HOUR", "25"))


def rate_limit(request: Request):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    now = time.time()
    calls = [t for t in RATE.get(ip, []) if now - t < 3600]
    if len(calls) >= RATE_PER_HOUR:
        raise HTTPException(429, f"You have asked {RATE_PER_HOUR} questions in the last hour. Please try again later.")
    RATE[ip] = calls + [now]


@app.post("/api/ask")
def ask(body: Ask, request: Request):
    rate_limit(request)
    history = [m for m in body.history if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)][-8:]
    model = pick_model(body.question)
    text, used, ok = run_claude(history + [{"role": "user", "content": body.question}], model, "ask")
    escalated = False
    if not ok and model == HAIKU:  # Haiku stalled: one retry on Sonnet
        model, escalated = SONNET, True
        text, used, ok = run_claude(history + [{"role": "user", "content": body.question}], SONNET, "ask-escalated", effort="medium")
    return {"answer": text, "tools": used, "model": model, "escalated": escalated}


NARRATE = {
    "ward": ("Write the one-page money trail for ward {key} for a corporator and citizens, using only the audited record "
             "below. Cover: budget vs spend, where the money went (contractors and methods), how much went on fixes that "
             "failed within 30 days, the money to question and why (cite the biggest work order ids), and the three things "
             "to fix next. For those three, use the issue ids, method and DLP note exactly as given in next_rupee_top: the "
             "method was chosen from city-wide durability data, so never override it from this ward's small samples, and "
             "say Rs 0 to BMC wherever there is a DLP note. Give failure rates as observed % and how many times the "
             "expected rate (reopen_oe). Also cover, briefly: the same roads (segments in same_roads, their repair count "
             "and spend, and that they need a structural inspection rather than another patch; say so if there are none), "
             "complaints marked Resolved whose fix failed (resolved_but_failed), and complaints closed without a fix "
             "(closed_without_fix, framed as 'verify jurisdiction', never as wrongdoing). If no_empanelled_contractor is "
             "true, note in one line that no contractor is empanelled for this ward, a records question for BMC. "
             "Under 280 words, short headed sections, fair tone."),
    "contractor": ("Write a fair, plain-language scorecard for contractor {key} for a citizen audience, using only the "
                   "audited record below. Cover speed (on time vs expected), how long repairs lasted (failed vs expected), "
                   "cost vs the rate card, billing flags with a few work order ids, and one thing to improve. Under 140 "
                   "words, no accusations."),
}


def narrate_request(kind, key):
    """One self-contained Sonnet request: the record goes inline, no tool loop."""
    record = t_ward(key) if kind == "ward" else t_contractor(key)
    if "error" in record:
        raise HTTPException(404, record["error"])
    prompt = NARRATE[kind].format(key=key) + "\n\n<record>\n" + json.dumps(record, ensure_ascii=False)[:40000] + "\n</record>"
    return dict(model=SONNET, max_tokens=4000, system=SYSTEM, messages=[{"role": "user", "content": prompt}],
                **request_args(SONNET, "medium"))


@app.get("/api/narrate/{kind}/{key:path}")
def narrate(kind: str, key: str, request: Request, refresh: bool = False, cached_only: bool = False):
    if kind not in NARRATE:
        raise HTTPException(404)
    if os.environ.get("MONSOON_PUBLIC"):  # on the public link, cached one-pagers are never rewritten
        refresh = False
    ck = f"{kind}:{key}"
    if ck not in CACHE and CACHE_PATH.exists():  # pick up narratives written by prewarm.py
        CACHE.update(json.loads(CACHE_PATH.read_text()))
    if ck in CACHE and not refresh:
        return {"text": CACHE[ck], "cached": True}
    if cached_only:
        return {"text": None, "cached": False}
    req = narrate_request(kind, key)  # 404s on an unknown key before any spend
    guard()
    rate_limit(request)
    resp = anthropic.Anthropic().messages.create(**req)
    log_usage(SONNET, resp.usage, f"narrate:{kind}")
    text = clean("".join(b.text for b in resp.content if b.type == "text").strip())
    if not text:
        raise HTTPException(502, "Claude returned no text.")
    CACHE[ck] = text
    CACHE_PATH.write_text(json.dumps(CACHE, ensure_ascii=False, indent=1))
    return {"text": text, "cached": False}


# ------------------------------------------------------------ role actions
# Drafts are documents a real person can send: Claude writes them from the
# audited record only, and each one is cached so a demo never pays twice.

DRAFTS_PATH = state_file("drafts.json")
DRAFTS = json.loads(DRAFTS_PATH.read_text()) if DRAFTS_PATH.exists() else {}
REPLIES_PATH = state_file("replies.json")
REPLIES = json.loads(REPLIES_PATH.read_text()) if REPLIES_PATH.exists() else {}
LANG = {"en": "English", "hi": "Hindi (Devanagari script)", "mr": "Marathi (Devanagari script)"}
CHRONIC = {s["road_id"]: s for s in DATA["same_roads"]}


def draft_record(kind, key, lang):
    if kind == "citizen_letter":
        rec = t_complaint(key)
        if "error" in rec:
            raise HTTPException(404, rec["error"])
        c = rec["complaint"]
        road = (rec.get("work_order") or {}).get("road_id") or c.get("road_guess")
        rec["road_history"] = {k: CHRONIC[road][k] for k in ("road_name", "jobs", "spend_inr", "failed", "under_dlp")} if road in CHRONIC else None
        rec["closed_as_other_agency_on_bmc_road"] = c["complaint_id"] in set(DATA["closed_unfixed_ids"])
        rec["ward_office"] = WARDS.get(c.get("ward_filled") or "", {}).get("office")
        return rec, (f"Write a short, polite escalation letter from the citizen who filed complaint {key} to the Assistant "
                     f"Commissioner of their ward office, in {LANG[lang]}. Use only the record below. State the complaint id and "
                     "date, what happened (the work order, contractor, whether the target time was met, whether the fix held), "
                     "and anything the record shows that matters: the road repaired many times (road_history), the complaint "
                     "closed as another agency's road although BMC repairs it, or never fixed. Ask for two or three specific, "
                     "reasonable actions with a date to reply by. No accusations, no legal threats. Under 180 words. "
                     "Leave [Name] and [Phone] as placeholders.")
    if kind == "dlp_notice":
        w = WARDS.get(key)
        if not w:
            raise HTTPException(404, f"No ward {key}")
        rows = [slim_wo(x) for x in WO.values() if x["ward_code"] == key and x["under_dlp"] == "Y"]
        roads = {}
        for x in rows:
            r = roads.setdefault(x["road_id"], {"road_name": x["road_name"], "jobs": [], "paid_inr": 0})
            r["jobs"].append({k: x[k] for k in ("work_order_id", "work_type", "completed_at", "cost_inr")})
            r["paid_inr"] += x["cost_inr"]
        rec = {"ward": key, "office": w["office"], "roads_under_dlp": roads, "total_paid_inr": sum(r["paid_inr"] for r in roads.values())}
        return rec, ("Draft a formal notice from the ward office to the contractors who resurfaced the road segments below, "
                     "which are still under their Defect Liability Period. Use only the record. For each road segment list the "
                     "work order ids and amounts BMC paid for repairs that the DLP contract should have covered. Ask the "
                     "contractor to confirm within 15 days whether the defects fall under their DLP obligations and, if so, to "
                     "reimburse or remedy at no cost to BMC. Note that the ward will verify each item against the original "
                     "contract before any recovery. Firm, factual, fair. Under 320 words. Use [Contractor name] and "
                     "[Contract number] placeholders, because the original resurfacing contractor is not in this dataset.")
    if kind == "committee_questions":
        rec = t_ward(key)
        if "error" in rec:
            raise HTTPException(404, rec["error"])
        return rec, (f"Write five questions a corporator can ask at the ward {key} committee meeting about monsoon road "
                     "repairs. Use only the record below. Each question must cite a specific number or work order id and "
                     "ask for an answer the ward office can give: recovery of DLP money, roads repaired again and again, "
                     "complaints closed without a fix, the never-fixed backlog and the budget. Fair and constructive, no "
                     "accusations. One short line of context then the question. Under 230 words.")
    raise HTTPException(404, "Unknown draft type")


class Draft(BaseModel):
    kind: str
    key: str
    lang: str = "en"
    refresh: bool = False
    cached_only: bool = False


@app.post("/api/draft")
def draft(body: Draft, request: Request):
    lang = body.lang if body.lang in LANG else "en"
    ck = f"{body.kind}:{body.key}:{lang}"
    if ck in DRAFTS and not body.refresh:
        return {"text": DRAFTS[ck], "cached": True}
    if body.cached_only:
        return {"text": None, "cached": False}
    rec, task = draft_record(body.kind, body.key.strip().upper() if body.kind != "dlp_notice" else body.key.strip().upper(), lang)
    guard()
    rate_limit(request)
    prompt = task + "\n\n<record>\n" + json.dumps(rec, ensure_ascii=False)[:40000] + "\n</record>"
    resp = anthropic.Anthropic().messages.create(model=SONNET, max_tokens=3000, system=SYSTEM,
                                                 messages=[{"role": "user", "content": prompt}], **request_args(SONNET, "medium"))
    log_usage(SONNET, resp.usage, f"draft:{body.kind}")
    text = clean("".join(b.text for b in resp.content if b.type == "text").strip())
    if not text:
        raise HTTPException(502, "Claude returned no text.")
    DRAFTS[ck] = text
    DRAFTS_PATH.write_text(json.dumps(DRAFTS, ensure_ascii=False, indent=1))
    return {"text": text, "cached": False}


class Reply(BaseModel):
    work_order_id: str
    contractor_id: str
    text: str


@app.get("/api/replies")
def replies():
    return REPLIES


@app.post("/api/reply")
def reply(body: Reply, request: Request):
    w = WO.get(body.work_order_id.strip().upper())
    if not w or w["contractor_id"] != body.contractor_id:
        raise HTTPException(400, "That work order is not one of this contractor's jobs.")
    text = body.text.strip()
    if not 10 <= len(text) <= 600:
        raise HTTPException(400, "Keep the reply between 10 and 600 characters.")
    rate_limit(request)
    REPLIES[w["work_order_id"]] = {"contractor_id": body.contractor_id, "text": clean(text), "at": time.strftime("%Y-%m-%d %H:%M")}
    REPLIES_PATH.write_text(json.dumps(REPLIES, ensure_ascii=False, indent=1))
    return {"ok": True}


@app.get("/api/usage")
def usage():
    rows = [json.loads(line) for line in LEDGER.read_text().splitlines()] if LEDGER.exists() else []
    by = {}
    for r in rows:
        k = f"{r['model']} {r['route']}"
        b = by.setdefault(k, dict(calls=0, usd=0.0, input=0, output=0))
        b["calls"] += 1
        b["usd"] += r["usd"]
        b["input"] += r["input"]
        b["output"] += r["output"]
    return {"today_usd": round(spent_today(), 4), "daily_cap_usd": DAILY_CAP,
            "all_time_usd": round(sum(r["usd"] for r in rows), 4), "by_route": by}


@app.get("/api/status")
def status():
    # MapTiler keys are browser keys by design; restrict yours to your domain in the MapTiler dashboard
    return {"claude": has_key(), "public": bool(os.environ.get("MONSOON_PUBLIC")), "maptiler_key": os.environ.get("MAPTILER_KEY", ""), "models": {"lookups": HAIKU, "judgement": SONNET}, "cached_narratives": len(CACHE),
            "today_usd": round(spent_today(), 4), "daily_cap_usd": DAILY_CAP}


@app.get("/data.json")
def data():
    return FileResponse(HERE / "data.json", media_type="application/json")


@app.get("/wards.geojson")
def geo():
    src = HERE.parent / "data" / "data" / "wards.geojson"
    return FileResponse(src if src.exists() else HERE / "public" / "wards.geojson", media_type="application/geo+json")


@app.middleware("http")
async def no_stale_assets(request, call_next):
    """Always revalidate the app's own files, so a viewer never runs an old app.js."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html", ".json", ".geojson")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


if (HERE / "static").exists():  # local run; on Vercel the CDN serves public/
    app.mount("/", StaticFiles(directory=HERE / "static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 3230)))
