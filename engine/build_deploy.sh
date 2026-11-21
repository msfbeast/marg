#!/bin/bash
# Assemble deploy/ for Vercel: the page and data are static files served by the CDN
# (public/), and only /api/* runs as a Python function (app.py, FastAPI + Anthropic SDK).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy"
rm -rf "$OUT/public" "$OUT/app.py" "$OUT/data.json" "$OUT/narratives.json" "$OUT/drafts.json" "$OUT/requirements.txt"
mkdir -p "$OUT/public"

# static site
cp "$ROOT/app/static/index.html" "$ROOT/app/static/style.css" "$ROOT/app/static/app.js" \
   "$ROOT/app/static/roles.js" "$ROOT/app/static/visuals.js" "$OUT/public/"
cp "$ROOT/app/data.json" "$OUT/public/data.json"
cp "$ROOT/data/data/wards.geojson" "$OUT/public/wards.geojson"

# API function and the records Claude reads
cp "$ROOT/app/server.py" "$OUT/app.py"
cp "$ROOT/app/data.json" "$OUT/data.json"
cp "$ROOT/app/narratives.json" "$OUT/narratives.json"
cp "$ROOT/app/drafts.json" "$OUT/drafts.json"
printf 'fastapi\nanthropic\n' > "$OUT/requirements.txt"

cat > "$OUT/.vercelignore" <<'EOF'
.env
*.jsonl
__pycache__
EOF
du -sh "$OUT" "$OUT/public"
