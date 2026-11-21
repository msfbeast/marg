# MARG: Monsoon Audit of Road Guarantees

Road-repair assurance for city corporations. *Marg* is the Hindi and Marathi word for road.

**Live:** https://marg-mumbai.vercel.app (deployed from `deploy/`, built by `engine/build_deploy.sh`)

A Claude-powered accountability tool for Mumbai's monsoon road repairs, built for
Claude Impact Lab Mumbai (21 Nov 2026) on the synthetic
[Claude-Impact-Labs-data-2](https://github.com/SumeetGDoshi/Claude-Impact-Labs-data-2) dataset.
All data is synthetic and every contractor is fictional.

## Run it

```bash
git clone https://github.com/SumeetGDoshi/Claude-Impact-Labs-data-2 data   # the challenge dataset
python3 -m venv .venv && .venv/bin/pip install pandas numpy scikit-learn shapely fastapi uvicorn anthropic
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env            # never committed (.gitignore)
echo 'MAPTILER_KEY=...' >> .env                     # optional: MapTiler Dataviz Dark basemap; falls back to OpenFreeMap
.venv/bin/python engine/audit.py                      # builds app/data.json from data/data/*.csv
.venv/bin/python app/server.py                        # http://127.0.0.1:3230
.venv/bin/python engine/prewarm.py                    # writes the 32 Claude narratives once, via the Batch API
```

The dashboard, auditor, scorecards, planner and complaint tracer work without a key.

## Claude cost plan

Cheapest model that does the job; Opus and Fable are never used.

| Job | Model | Why | Rough cost |
|---|---|---|---|
| Chat lookups ("what happened to BMC25-000006", "flags in K/W") | Haiku 5.5, effort low | fetching and phrasing records | about US$0.002 a question |
| Chat judgement ("why", "compare", "fair", "should", "plan", kyun, क्यों, का म्हणून) | Sonnet 5.5 | weighing evidence fairly | about US$0.03 to 0.08 a question |
| Haiku stalls or returns nothing | one retry on Sonnet | | only when needed |
| 24 ward one-pagers + 8 contractor scorecards | Sonnet 5.5, data inline, one call each, Batch API | written once, cached in `app/narratives.json` | about US$0.30 for all 32 |

Every call is logged to `usage.jsonl` with its dollar cost (`/api/usage` sums it by route), and a daily cap
(`MONSOON_DAILY_USD`, default 2) stops new calls once reached. The system prompt and tools are marked for prompt caching.
Sonnet requests carry the server-side refusal fallback.

## What it found

| Finding | Jobs | Money | How it is detected |
|---|---:|---:|---|
| Paid during Defect Liability Period | 493 | Rs 2.62 Cr | `roads.under_dlp = Y`: repairs there are the original contractor's job at no cost to BMC. Split: road-surface defects Rs 87.3 L (274 jobs, the clearest case); drainage, pumping and manholes Rs 1.75 Cr (219 jobs, check against each DLP contract) |
| Billed twice | 45 | Rs 25.9 L | a job with no complaint linked that copies an earlier job (same road, work type, contractor, exact area) within 7 days; every one of the 45 blank-link jobs has such a twin |
| Over the rate card | 114 (111 clear, 3 review) | Rs 60.7 L excess | cost / (area x rate or per-job rate); normal work is 0.75x to 1.30x, and the flagged jobs start at 1.32x |
| **To question, each job counted once** | | **Rs 3.35 Cr of Rs 13.43 Cr** | |
| Fixes that failed within 30 days | 611 | Rs 3.07 Cr | not counted as recoverable; feeds the scorecards |

Over-billing is concentrated: Mahalaxmi Civil Contractors (44 jobs) and Arabian Sea Engineering (38) hold 82 of the 114.

### What else we tested

The brief says the best teams will find the hidden problems, so every plausible variant was tested.
The app shows this log on the Auditor page ("What we looked for").

| Area | Hypothesis | Verdict |
|---|---|---|
| Inflated bills | Cost vs rate card | **Found**: 114 jobs, median 2.1x, clean gap above 1.30x |
| | Padded areas, quiet shading, up-coding to pricier methods, phantom fast jobs | Ruled out: patch areas 7.2 to 8.4 sqm mean per contractor, normal bills 1.03x to 1.05x for all, mastic share 20 to 30% for all, no instant jobs |
| Duplicate charges | No-complaint copy of an earlier job | **Found**: 45 of 45 |
| | Twins with complaints on both, one complaint on two jobs, identical amounts | Ruled out |
| Warranty violations | Paid repairs on DLP roads | **Found**: 493 jobs, Rs 2.62 Cr |
| | Roads resurfaced since 2023 but marked not under DLP | **Verify**: 26 segments, 224 jobs, Rs 1.10 Cr; uneven by year, may be a records gap; not counted |
| | Contractor paid to redo its own failed fix, utility trench damage, hidden re-opens | Ruled out (normal share, random remarks, follow-ups equal for flagged and unflagged) |

Two context findings that change how the numbers should be read:

- **Delay costs lives.** Road-defect accidents happen 3.3x as often on road-days with an unresolved complaint
  (6.79 vs 2.04 per 1,000 road-days); other accidents rise only 1.5x. All 191 road-defect accidents fall in the 2025 monsoon.
  Failed fixes, by contrast, are not followed by more accidents.
- **The 24 h SLA is met 3% of the time** across all contractors. Raw on-time rates punish whoever gets the urgent jobs,
  so speed is scored against an expected rate (SLA tier, work type, ward flood risk, rain, crew workload).

### Second pass: re-reading the brief

| Finding | Number | Verdict |
|---|---|---|
| **The same roads.** "Mumbai spends crores fixing the same roads" | 50 of 285 segments repaired 15+ times took Rs 6.41 Cr, 48% of all spend. Kurla Andheri Road (RD0220, ward L): 35 repairs, Rs 30.5 L, while under DLP. 11 chronic segments are under DLP | Found |
| **Resolved is not fixed** | 962 of 3,934 complaints marked Resolved (24%) were linked to a fix that re-opened within 30 days | Found |
| **Closed as someone else's road** | 576 of 580 complaints closed as "Not BMC road" or forwarded to MMRDA/PWD sit on segments BMC itself repairs and paid for this season | Verify (road matching from text is ~76% exact) |
| **Outside the empanelled wards** | 1,987 of 2,499 jobs (Rs 10.73 Cr); 6 wards have no empanelled contractor yet Rs 3.46 Cr of work; uniform 69 to 85% for every contractor | Verify: a records gap, not misconduct |
| **Social posts** | 650 posts classified (reports, urgent, "fixed but BACK", thanks, satire, unverified forwards). 13 "BACK" posts match exactly one contractor's failed fix 2 to 10 days earlier; 172 open issues are also being discussed online | Supporting context only |
| **Cold mix on concrete** | Fails 42% vs 31% on asphalt, but hot mix also fails more on concrete (31% vs 22%) | It is the road: surface added to the fairness model and the planner picks the method per surface |

Ruled out in the second pass: repeat complainants (all ids unique), lenient SLA tiers for favoured contractors,
linking errors (0 ward mismatches), unlinked fixes (306 vs a 291 placebo), red-alert work failing more, two-wheeler exposure.
Risk now also weighs hospital beds and school enrolment, flood water recession time and pumping stations.
The investigation log in the app lists all 29 checks.

## Fair scorecards

Durability is observed re-opens divided by expected re-opens, and speed is observed on-time rate divided by expected. Expected comes from a logistic
model on things the contractor does not control: repair method, the ward's low-lying index, rain at the
ward's gauge in the 30 days after the job, congestion and road class. Speed and billing use rates, so volume is never punished.

| Contractor | Grade | Failed | Expected | On time | Expected |
|---|:-:|---:|---:|---:|---:|
| Sahyadri Infra Works | A | 13.6% | 24.6% | 62.3% | 50.4% |
| Deccan Paving Solutions | A | 9.1% | 23.9% | 59.6% | 51.0% |
| Mithi Infra Projects | A | 11.6% | 24.7% | 51.7% | 48.6% |
| Konkan Roadcon Pvt Ltd | C | 26.7% | 24.1% | 46.0% | 46.4% |
| Shivneri Construction | C | 26.3% | 24.2% | 47.1% | 48.4% |
| Western Coast Asphalt Co | D | 38.8% | 24.7% | 47.2% | 46.8% |
| Arabian Sea Engineering | E | 32.3% | 24.8% | 43.6% | 52.4% |
| Mahalaxmi Civil Contractors | E | 37.6% | 24.7% | 39.3% | 53.2% |

## Connecting the trail

- Issue type: photo description first (100% match with the linked job's work type), then English text and helpline notes (100%), then the citizen's pick (87%). Overall 95.1%, up from 83.5% for the picked category, measured on the 4,948 complaints the dataset itself links to a job (in-sample: the rules were written on this data, there is no held-out set). 176 complaints with no usable evidence go to "Needs inspection" instead of a guess. Hindi, Marathi and Hinglish free text does not track the real issue in this dataset, so it is used only for place names.
- Ward: 451 blank wards filled from the locality gazetteer (incl. Devanagari aliases), 98.5% correct against linked jobs.
- 892 open or in-progress complaints merge into 428 never-fixed issues (one per road segment and type).

## Next rupee

Each never-fixed issue gets a 0 to 100 risk score: severity (30, each type's average SLA tier in 2025, since nothing
observable predicted severity within a type), complaints and me-too votes (15),
nearby flood hotspot (15: days in 2025 the ward's rain gauge crossed that spot's flood threshold, big-tide days for
tide-sensitive spots, years flagged, water depth), traffic and BEST buses (12),
road-defect accidents (13), hospital ambulance route or school access (10), past failures on that road (5).
The method is the most durable one for the issue type unless it costs over 1.5x the cheapest per durable fix
(potholes: hot mix, which holds 77% vs 68.5% for cold mix and wins within every contractor).
Any issue on a DLP road goes back to the original contractor at Rs 0, the same rule the auditor uses. The planner fills a ward's budget in risk order.

## Using it

- **Play the story** (top bar): seven guided beats, the two-minute demo. Arrow keys step through, Esc exits.
- **Money trail**: money to question, the same roads, did the fix last, budget vs spend. The timeline at the
  bottom of the map plays the monsoon week by week: rain in blue, each repair appearing as it was finished.
- **Auditor**: every flag with its evidence, CSV export, and the log of all 29 hypotheses tested.
- **Scorecards**: contractors against what was expected for their conditions, with Claude's citizen scorecards.
- **Next rupee**: risk-ranked fixes inside a ward's budget, and next season's total split across wards by need
  (2025 clean spend plus the never-fixed backlog; DLP fixes left to the contractors who owe them).
- **My complaint**: how messy complaints become clean issues (a real Marathi example), the tracer, and Ask Claude.

## Roles: who can act on it

"View as" in the top bar rearranges the same evidence for the person who has to act, and gives them a
document Claude drafts from the audited record (cached, so a demo never pays twice):

| Role | Action |
|---|---|
| Citizen | Escalation letter to the ward office in English, Hindi or Marathi; copy, download or share on WhatsApp |
| Ward officer | DLP recovery notice listing every work order and amount; jurisdiction checklist CSV; next week's work packet CSV |
| Corporator | Five evidence-backed questions for the ward committee meeting |
| Contractor | Their scorecard and a right of reply on each flagged job, shown to everyone on the job's evidence card |

There is no real sign-in in this demo; in production each role would use BMC's own login.
For a public link, set `MONSOON_PUBLIC=1` (no paid rewrites of cached one-pagers) and
`MONSOON_CALLS_PER_HOUR` (default 25 Claude calls per visitor per hour) alongside the daily cap.

## Layout

- `engine/audit.py`: the whole audit, deterministic, writes `app/data.json`
- `app/server.py`: FastAPI server, Claude tool-use loop on the Messages API run locally (`/api/ask`), cached narratives (`/api/narrate`)
- `engine/extras.py`: second-pass analyses (same roads, closed without a fix, resolved-but-failed, empanelment, social posts)
- `app/static/`: the UI (no build step): a dark map control room on MapLibre with OpenFreeMap tiles
  (real OpenStreetMap streets; repair data drawn on top). Basemap needs internet; everything else is local.
