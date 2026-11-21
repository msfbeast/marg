"""Write every ward one-pager and contractor scorecard once, through the
Message Batches API (half price), and cache them in app/narratives.json so the
demo shows them instantly and works offline.

    .venv/bin/python engine/prewarm.py            # only what is missing
    .venv/bin/python engine/prewarm.py --refresh  # rewrite all 32
    .venv/bin/python engine/prewarm.py --refresh --only=contractor

Reads ANTHROPIC_API_KEY from Monsoon/.env. Costs are logged to usage.jsonl.
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))
import anthropic  # noqa: E402
import server as S  # noqa: E402  (loads .env, data, prompts)

if not S.has_key():
    sys.exit("No ANTHROPIC_API_KEY. Put it in Monsoon/.env first.")

refresh = "--refresh" in sys.argv
jobs = [("ward", w["ward_code"]) for w in S.DATA["wards"]] + [("contractor", c["contractor_id"]) for c in S.DATA["contractors"]]
only = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), None)  # ward | contractor
if only:
    jobs = [j for j in jobs if j[0] == only]
jobs = [j for j in jobs if refresh or f"{j[0]}:{j[1]}" not in S.CACHE]
if not jobs:
    sys.exit("All 32 narratives are already cached. Use --refresh to rewrite them.")

reqs, ids = [], {}
for kind, key in jobs:
    p = S.narrate_request(kind, key)
    params = dict(model=p["model"], max_tokens=p["max_tokens"], system=p["system"], messages=p["messages"],
                  output_config=p["extra_body"]["output_config"])
    cid = f"{kind}-{key.replace('/', '_')}"
    ids[cid] = (kind, key)
    reqs.append({"custom_id": cid, "params": params})

client = anthropic.Anthropic()
batch = client.messages.batches.create(requests=reqs)
print(f"Batch {batch.id}: {len(reqs)} requests on {S.SONNET} at half price. Waiting…", flush=True)
while True:
    b = client.messages.batches.retrieve(batch.id)
    if b.processing_status == "ended":
        break
    print(f"  {b.request_counts.succeeded} done, {b.request_counts.processing} processing", flush=True)
    time.sleep(20)

usd, ok, bad = 0.0, 0, []
for r in client.messages.batches.results(batch.id):
    kind, key = ids[r.custom_id]
    if r.result.type != "succeeded":
        bad.append(f"{r.custom_id}: {r.result.type}")
        continue
    m = r.result.message
    usd += S.log_usage(S.SONNET, m.usage, f"prewarm:{kind}", batch=True)
    text = S.clean("".join(b.text for b in m.content if b.type == "text").strip())
    if text:
        S.CACHE[f"{kind}:{key}"] = text
        ok += 1
S.CACHE_PATH.write_text(json.dumps(S.CACHE, ensure_ascii=False, indent=1))
print(f"Cached {ok} narratives for ${usd:.3f}." + (f" Failed: {bad}" if bad else ""))
