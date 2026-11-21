/* MARG control room. Every number comes from data.json (engine/audit.py). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function inr(n, short = true) {
  n = Math.round(n || 0);
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (short && a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (short && a >= 1e5) return `${s}₹${(a / 1e5).toFixed(1)} L`;
  return `${s}₹${a.toLocaleString("en-IN")}`;
}
/* big numeral with faded unit, e.g. ₹3.35 Cr */
function bigInr(n) {
  const t = inr(n);
  const m = t.match(/^(-?₹)([\d,]+)(\.\d+)?\s?(Cr|L)?$/);
  if (!m) return esc(t);
  return `${m[1]}${m[2]}<span class="f">${m[3] || ""}</span>${m[4] ? `<span class="u">${m[4]}</span>` : ""}`;
}
const pct = (x, d = 0) => `${(+x).toFixed(d)}%`;
const FLAG = { DLP_RECORDS_GAP: "DLP records gap", DUPLICATE: "Billed twice", DLP_PAID: "Paid during DLP", OVERBILLED: "Over rate card", SLA_MISSED: "Missed SLA", REOPENED: "Failed in 30 days", OUTSIDE_PANEL: "Outside panel" };
const CHRONIC = {};
const CLOSED = new Set();
const MUMBAI = [[72.79, 18.9], [72.99, 19.27]];

let D, GEO, map, mapReady = false;
const WO = {}, CP = {}, WARD = {}, PLAN = {}, ROAD = {};
const S = { tab: "trail", ward: "", flag: "ALL", shown: 40, budget: null, issue: null, trace: null, week: null, dockOpen: false };

/* ------------------------------------------------------------------ boot */
async function boot() {
  [D, GEO] = await Promise.all([fetch("data.json").then((r) => r.json()), fetch("wards.geojson").then((r) => r.json())]);
  D.work_orders.forEach((w) => (WO[w.work_order_id] = w));
  D.complaints.forEach((c) => (CP[c.complaint_id] = c));
  D.wards.forEach((w) => (WARD[w.ward_code] = w));
  D.plan.forEach((p) => (PLAN[p.issue_id] = p));
  D.map.roads.forEach((r) => (ROAD[r.id] = r));
  D.same_roads.forEach((s) => (CHRONIC[s.road_id] = s));
  D.closed_unfixed_ids.forEach((c) => CLOSED.add(c));
  if (typeof initRoles === "function") await initRoles();
  $("#ward-sel").innerHTML = `<option value="">All Mumbai · 24 wards</option>` + D.wards.map((w) => `<option value="${w.ward_code}">${w.ward_code} · ${esc(w.ward_name)}</option>`).join("");
  $("#ward-sel").addEventListener("change", (e) => selectWard(e.target.value));
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => userGo(b.dataset.tab)));
  $("#find").addEventListener("submit", (e) => { e.preventDefault(); find($("#find-q").value); });
  $("#story-btn").addEventListener("click", () => (STORY == null ? story(0) : endStory()));
  status();
  const h = location.hash.slice(1).split("/");
  if (h[1]) S.ward = decodeURIComponent(h[1]);
  if (["trail", "audit", "cards", "plan", "ask"].includes(h[0])) S.tab = h[0];
  $("#ward-sel").value = S.ward;
  render();
  await initMap();
  if (typeof initVisuals === "function") initVisuals();
  mapMode();
  fitScope();
}

function go(tab) { S.tab = tab; S.shown = 40; closeCard(); render(); }
function userGo(tab) { endStory(); go(tab); }
function selectWard(code) {
  S.ward = code || "";
  $("#ward-sel").value = S.ward;
  if (S.tab === "plan") S.budget = null;
  closeCard();
  render();
  fitScope();
}
function syncHash() { history.replaceState(null, "", `#${S.tab}${S.ward ? "/" + encodeURIComponent(S.ward) : ""}`); }

function status() {
  fetch("/api/status").then((r) => r.json()).then((s) => {
    const el = $("#c-status");
    el.className = "claude" + (s.claude ? " on" : "");
    el.textContent = !s.claude ? "Claude offline" : s.public ? "Claude connected" : `Claude · US$ ${s.today_usd.toFixed(2)} today`;
    el.title = s.claude ? `Haiku for lookups, Sonnet for judgement. Daily cap US$ ${s.daily_cap_usd}.` : "Add ANTHROPIC_API_KEY to .env";
  }).catch(() => { $("#c-status").textContent = "Claude offline"; });
}

/* ------------------------------------------------------------------ map */
/* MapTiler's Dataviz Dark (built for data overlays) when a key is set; OpenFreeMap otherwise */
async function maptilerStyle() {
  let key = "";
  try { key = (await fetch("/api/status").then((r) => r.json())).maptiler_key || ""; } catch (e) { return null; }
  if (!key) return null;
  try {
    const st = await fetch(`https://api.maptiler.com/maps/dataviz-dark/style.json?key=${encodeURIComponent(key)}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    for (const l of st.layers) {
      const p = (l.paint = l.paint || {});
      if (l.type === "background") p["background-color"] = "#0B110E";
      else if (l.type === "fill" && /water|ocean|sea/i.test(l.id)) p["fill-color"] = "#061016";
      if (l.type === "symbol" && /road|street|highway|path|poi|village|hamlet|aeroway|airport|ferry|transit|station|rail|one.?way|housenumber|state|country|continent/i.test(l.id)) l.layout = { ...(l.layout || {}), visibility: "none" };
      if (l.type === "symbol" && /place|city|town|suburb|neighbou?rhood/i.test(l.id)) { p["text-color"] = "#5F6B64"; p["text-halo-color"] = "#090D0B"; }
    }
    window.BASEMAP = "maptiler";
    return st;
  } catch (e) { console.warn("MapTiler unavailable, using OpenFreeMap", e); return null; }
}
async function darkStyle() {
  const mt = await maptilerStyle();
  if (mt) return mt;
  window.BASEMAP = "openfreemap";
  try {
    const st = await fetch("https://tiles.openfreemap.org/styles/dark").then((r) => r.json());
    for (const l of st.layers) {
      const p = (l.paint = l.paint || {});
      const id = l.id;
      if (l.type === "background") p["background-color"] = "#0B110E";
      else if (id === "water") p["fill-color"] = "#061016";
      else if (id === "waterway") p["line-color"] = "#0A1A22";
      else if (id.startsWith("landuse_residential")) { p["fill-color"] = "#101713"; p["fill-opacity"] = 0.6; }
      else if (id.startsWith("landcover_wood") || id.startsWith("landuse_park")) { p["fill-color"] = "#0F1C15"; p["fill-opacity"] = 0.7; }
      else if (id === "building") { p["fill-color"] = "#121915"; p["fill-outline-color"] = "#18211C"; }
      else if (l.type === "line" && id.startsWith("highway")) {
        p["line-color"] = id.includes("motorway") ? "#334039" : id.includes("major") ? "#28332D" : "#1B241F";
      } else if (l.type === "line" && id.startsWith("railway")) p["line-color"] = "#222C27";
      else if (l.type === "line" && id.startsWith("aeroway")) p["line-color"] = "#1B241F";
      else if (l.type === "symbol") { p["text-color"] = "#66726B"; p["text-halo-color"] = "#090D0B"; }
      if (id.startsWith("boundary")) l.layout = { ...(l.layout || {}), visibility: "none" };
      // fewer labels: our data is the subject, the basemap is context
      if (/highway_name|road_oneway|place_village|place_other|place_country|place_state|water_name|aeroway/.test(id) && l.type === "symbol") l.layout = { ...(l.layout || {}), visibility: "none" };
      if (/place_suburb|place_town|place_city/.test(id)) { p["text-color"] = "#57625B"; p["text-opacity"] = 0.85; }
      if (p["fill-pattern"]) { delete p["fill-pattern"]; p["fill-color"] = "#0F1C15"; }
      if (id === "aeroway-area") { p["fill-color"] = "#121915"; p["fill-opacity"] = 0.8; }
    }
    return st;
  } catch (e) {
    console.warn("basemap unavailable, drawing data only", e);
    return { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0B110E" } }] };
  }
}

function roadMid(id) { const r = ROAD[id]; return r ? [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2] : null; }
function jitter(id, p, amt = 0.0011) {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [p[0] + (((h % 1000) / 1000) - 0.5) * amt * 2, p[1] + ((((h >> 10) % 1000) / 1000) - 0.5) * amt * 2];
}
function wardBounds(code) {
  const f = GEO.features.find((x) => x.properties.ward_code === code);
  const xs = f.geometry.coordinates[0].map((c) => c[0]), ys = f.geometry.coordinates[0].map((c) => c[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}
function pad() {
  const w = window.innerWidth;
  if (w < 1100) return 20;
  const dockH = $("#dock").classList.contains("hidden") ? 0 : $("#dock").classList.contains("min") ? 60 : $("#dock").offsetHeight;
  const tlH = S.tab === "trail" ? 96 : 0;
  return { top: 110, bottom: dockH + tlH + 24, left: 30, right: $("#fcard").hidden ? 250 : 420 };
}
function fitScope() {
  if (!mapReady) return;
  if (!S.ward && S.tab === "trail" && window.innerWidth >= 1100) {
    const p = pad();
    map.flyTo({ center: [72.862, 19.035], zoom: 10.9, pitch: 48, bearing: 22, padding: { top: 80, bottom: p.bottom - 20, left: 0, right: 200 }, duration: 1200 });
    return;
  }
  map.fitBounds(S.ward ? wardBounds(S.ward) : MUMBAI, { padding: pad(), duration: 900, maxZoom: 14, pitch: 0, bearing: 0 });
}

async function initMap() {
  const style = await darkStyle();
  if ($("#bm-credit")) $("#bm-credit").textContent = window.BASEMAP === "maptiler" ? "MapTiler" : "OpenFreeMap";
  map = new maplibregl.Map({ container: "map", style, bounds: MUMBAI, fitBoundsOptions: { padding: 30 }, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: window.innerWidth < 1100 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  await new Promise((res) => map.on("load", res));
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("wards", { type: "geojson", data: GEO, promoteId: "ward_code" });
  map.addSource("roads", { type: "geojson", data: { type: "FeatureCollection", features: D.map.roads.map((r) => ({ type: "Feature", properties: { id: r.id, bus: r.bus, dlp: r.dlp, ward: r.ward }, geometry: { type: "LineString", coordinates: [r.a, r.b] } })) } });
  map.addSource("hot", { type: "geojson", data: { type: "FeatureCollection", features: D.map.hotspots.map((h) => ({ type: "Feature", properties: h, geometry: { type: "Point", coordinates: [h.lon, h.lat] } })) } });
  map.addSource("pins", { type: "geojson", data: empty });
  map.addSource("sel", { type: "geojson", data: empty });

  // ward shapes are approximate and spill into the sea, so draw them under the real water layer
  const under = (map.getStyle().layers.find((l) => l.type === "fill" && /^water$|water/i.test(l.id)) || {}).id;
  map.addLayer({ id: "ward-fill", type: "fill", source: "wards", paint: { "fill-color": "#FF7A1A", "fill-opacity": 0 } }, under);
  map.addLayer({ id: "ward-line", type: "line", source: "wards", paint: { "line-color": ["case", ["boolean", ["feature-state", "sel"], false], "#EEF2EE", "#3B4A42"], "line-width": ["case", ["boolean", ["feature-state", "sel"], false], 2.2, 0.9], "line-opacity": 0.9 } }, under);
  // Mumbai only: fade everything outside the city's ward outline, and keep the camera near it
  const world = [[40, 0], [110, 0], [110, 40], [40, 40], [40, 0]];
  map.addSource("mask", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, D.map.outline] } } });
  map.addLayer({ id: "mask", type: "fill", source: "mask", paint: { "fill-color": "#061016", "fill-opacity": 0.92 } });
  map.addSource("edge", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: D.map.outline } } });
  map.addLayer({ id: "edge", type: "line", source: "edge", paint: { "line-color": "#3B4A42", "line-width": 1, "line-opacity": 0 } });
  map.setMaxBounds([[72.6, 18.78], [73.17, 19.42]]);
  map.setMinZoom(9.6);
  map.addLayer({ id: "roads", type: "line", source: "roads", layout: { "line-cap": "round" }, paint: { "line-color": ["case", ["get", "dlp"], "#5E7A6C", "#3C4A43"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 4], "line-opacity": 0.85 } });
  map.addSource("chronic", { type: "geojson", data: { type: "FeatureCollection", features: D.same_roads.map((s) => { const r = ROAD[s.road_id]; return { type: "Feature", properties: { id: s.road_id, jobs: s.jobs, dlp: s.under_dlp }, geometry: { type: "LineString", coordinates: [r.a, r.b] } }; }) } });
  // repeat-repair roads glow hot white: orange is reserved for money to question
  map.addLayer({ id: "chronic-glow", type: "line", source: "chronic", layout: { "line-cap": "round" }, paint: { "line-color": "#F6EFDD", "line-blur": 6, "line-opacity": 0, "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["/", ["get", "jobs"], 2.5], 15, ["get", "jobs"]] } });
  map.addLayer({ id: "chronic", type: "line", source: "chronic", layout: { "line-cap": "round" }, paint: { "line-color": ["interpolate", ["linear"], ["get", "jobs"], 15, "#BDB6A4", 35, "#FFFFFF"], "line-opacity": 0, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 7] } });
  map.addSource("jobs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "jobs", type: "circle", source: "jobs", paint: { "circle-color": ["case", ["get", "flag"], "#FF7A1A", "#C9D2CC"], "circle-opacity": ["case", ["get", "now"], 0.95, 0.18], "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "now"], 3, 1.4], 15, ["case", ["get", "now"], 7, 3]] } });
  map.addLayer({ id: "hot-glow", type: "circle", source: "hot", paint: { "circle-color": "#4DB3E6", "circle-blur": 1, "circle-opacity": 0.35, "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["+", 6, ["*", ["get", "wet_days"], 0.9]], 15, ["+", 30, ["*", ["get", "wet_days"], 3]]] } });
  map.addLayer({ id: "hot-core", type: "circle", source: "hot", paint: { "circle-color": "#4DB3E6", "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6], "circle-stroke-color": "#061016", "circle-stroke-width": 1 } });
  // one label per ward, from its centroid (polygon labels repeat once per map tile)
  map.addSource("ward-pts", { type: "geojson", data: { type: "FeatureCollection", features: D.wards.map((w) => pt(w.centroid, { ward_code: w.ward_code })) } });
  map.addLayer({ id: "ward-label", type: "symbol", source: "ward-pts", layout: { "text-field": ["get", "ward_code"], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 14, 16], "text-allow-overlap": true }, paint: { "text-color": "#C9D2CC", "text-halo-color": "#090D0B", "text-halo-width": 1.4 } });
  map.addLayer({ id: "pins-halo", type: "circle", source: "pins", paint: { "circle-color": ["get", "color"], "circle-blur": 1, "circle-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.06, 13, 0.35], "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["*", ["get", "r"], 1.2], 14, ["*", ["get", "r"], 2.4]] } });
  map.addLayer({ id: "pins", type: "circle", source: "pins", paint: { "circle-color": ["get", "color"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["*", ["get", "r"], 0.5], 14, ["get", "r"]], "circle-stroke-color": ["get", "ring"], "circle-stroke-width": ["get", "rw"], "circle-opacity": 0.95 } });
  map.addLayer({ id: "sel", type: "circle", source: "sel", paint: { "circle-color": "transparent", "circle-radius": 14, "circle-stroke-color": "#EEF2EE", "circle-stroke-width": 2 } });

  map.on("click", (e) => {
    const p = map.queryRenderedFeatures(e.point, { layers: ["pins", "jobs", "hot-core", "chronic"] })[0];
    if (p) {
      if (p.layer.id === "hot-core") return showHotspot(p.properties);
      if (p.layer.id === "chronic") { if (S.tab === "trail") return showRoad(p.properties.id); }
      const k = p.properties;
      if (k.kind === "wo") return showWo(k.id);
      if (k.kind === "issue") return showIssue(k.id);
      return;
    }
    const w = map.queryRenderedFeatures(e.point, { layers: ["ward-fill"] })[0];
    if (w && S.tab !== "ask") selectWard(w.properties.ward_code === S.ward ? "" : w.properties.ward_code);
  });
  for (const l of ["pins", "jobs", "hot-core", "ward-fill", "chronic"]) {
    map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
  }
  mapReady = true;
  fitScope();
}

let lastSel = null;
function mapMode() {
  if (!mapReady) return;
  if (lastSel) map.setFeatureState({ source: "wards", id: lastSel }, { sel: false });
  if (S.ward) map.setFeatureState({ source: "wards", id: S.ward }, { sel: true });
  lastSel = S.ward || null;

  const share = (w) => w.recoverable_inr / Math.max(w.spend_inr, 1);
  let fill = ["literal", "#FF7A1A"], op = 0;
  if (S.tab === "trail" || S.tab === "audit") {
    fill = "#EEF2EE";
    op = S.ward ? ["match", ["get", "ward_code"], S.ward, 0.06, 0] : 0;
  } else if (S.tab === "cards") {
    const m = ["match", ["get", "ward_code"]];
    D.wards.forEach((w) => m.push(w.ward_code, w.score >= 72 ? "#6FD6A8" : w.score >= 64 ? "#F2C14E" : "#FF7A1A"));
    m.push("#6FD6A8");
    fill = m; op = 0.22;
  } else if (S.tab === "plan") { fill = "#4DB3E6"; op = 0.03; }
  map.setPaintProperty("ward-fill", "fill-color", fill);
  // fade ward tints as you zoom into streets, so the street map stays readable
  map.setPaintProperty("ward-fill", "fill-opacity", typeof op === "number" ? ["interpolate", ["linear"], ["zoom"], 11.5, op, 14, op * 0.25] : ["interpolate", ["linear"], ["zoom"], 11.5, op, 14, ["*", op, 0.25]]);
  map.setPaintProperty("hot-glow", "circle-opacity", S.tab === "plan" ? 0.5 : 0.22);
  const showChronic = S.tab === "trail";
  map.setPaintProperty("chronic", "line-opacity", showChronic ? 0.95 : 0);
  map.setPaintProperty("chronic-glow", "line-opacity", showChronic ? 0.35 : 0);

  const feats = [];
  const wardOk = (w) => !S.ward || w === S.ward;
  if (S.tab === "audit") {
    auditRows().forEach((w) => {
      const p = roadMid(w.road_id); if (!p) return;
      const r = 3 + Math.min(Math.sqrt(w.recoverable_inr) / 60, 9);
      feats.push(pt(jitter(w.work_order_id, p), { kind: "wo", id: w.work_order_id, r, color: "#FF7A1A", ring: "#2A1406", rw: 1 }));
    });
  }
  if (S.tab === "plan") {
    planItems().forEach(({ p, fits }) => {
      const loc = p.lat != null ? [p.lon, p.lat] : p.road_id ? roadMid(p.road_id) : null; if (!loc) return;
      const col = p.risk >= 65 ? "#FF5A3C" : p.risk >= 50 ? "#FF7A1A" : p.risk >= 38 ? "#F2C14E" : "#8C968F";
      feats.push(pt(jitter(p.issue_id, loc, 0.0005), { kind: "issue", id: p.issue_id, r: 3 + (p.risk / 100) * 9, color: fits ? col : "#4A544E", ring: p.dlp_note ? "#6FD6A8" : "#090D0B", rw: p.dlp_note ? 2 : 1 }));
    });
  }
  if (S.tab === "ask" && S.trace) {
    const c = CP[S.trace];
    const w = WO[D.issue_to_wo[c.issue_id]];
    const p = PLAN[c.issue_id];
    const loc = w ? roadMid(w.road_id) : p && p.lat != null ? [p.lon, p.lat] : c.road_guess ? roadMid(c.road_guess) : null;
    if (loc) feats.push(pt(loc, { kind: w ? "wo" : "issue", id: w ? w.work_order_id : c.issue_id, r: 8, color: w && w.reopened_within_30d === "N" ? "#6FD6A8" : "#FF7A1A", ring: "#EEF2EE", rw: 2 }));
  }
  map.getSource("pins").setData({ type: "FeatureCollection", features: feats.filter((f) => wardOk(f.properties.ward ?? S.ward)) });
  jobsLayer();
}
const pt = (c, props) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });

/* ------------------------------------------------------------ timeline */
let WEEKS = [], playTimer = null;
function weekStart(k) { const d = new Date(2025, 0, 1 + k * 7); return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
function timelineData() {
  const st = S.ward && isIsland(S.ward) ? "Colaba" : "Santacruz";
  const sp = {}, rn = {};
  scopeWOs().forEach((w) => { const k = weekKey(w.completed_at); sp[k] = (sp[k] || 0) + w.cost_inr; });
  D.map.rain.forEach((r) => { const k = weekKey(r.date); rn[k] = (rn[k] || 0) + r[st]; });
  WEEKS = [...new Set([...Object.keys(rn), ...Object.keys(sp)].map(Number))].sort((a, b) => a - b);
  return { sp, rn, st };
}
function timeline() {
  $("#tl")?.remove();
  if (S.tab !== "trail") { stopPlay(); return; }
  const { sp, rn, st } = timelineData();
  const whole = S.week == null || !WEEKS.includes(S.week);
  const n = WEEKS.length, ms = Math.max(...WEEKS.map((k) => sp[k] || 0), 1), mr = Math.max(...WEEKS.map((k) => rn[k] || 0), 1);
  const cur = whole ? n - 1 : WEEKS.indexOf(S.week);
  const upto = whole ? WEEKS[n - 1] : S.week;
  const bars = WEEKS.map((k, i) => {
    const x = (i / n) * 1000, w = 1000 / n;
    const hr = ((rn[k] || 0) / mr) * 54, hs = ((sp[k] || 0) / ms) * 54;
    return `<rect x="${x + 2}" y="${58 - hr}" width="${w - 4}" height="${hr}" rx="2" fill="#4DB3E6" opacity="${k <= upto ? 0.55 : 0.18}"/><rect x="${x + w * 0.3}" y="${58 - hs}" width="${w * 0.4}" height="${hs}" rx="1.5" fill="${!whole && k === S.week ? "#EEF2EE" : "#8C968F"}" opacity="${k <= upto ? 1 : 0.3}"/>`;
  }).join("");
  const cum = WEEKS.filter((k) => k <= upto).reduce((a, k) => a + (sp[k] || 0), 0);
  const rainAll = WEEKS.reduce((a, k) => a + (rn[k] || 0), 0);
  $("#mapwrap").insertAdjacentHTML("beforeend", `<div class="timeline-bar glass" id="tl">
    <button class="play" id="tl-play" aria-label="Play the monsoon">${playTimer ? "❚❚" : "▶"}</button>
    <div class="tl"><svg viewBox="0 0 1000 60" preserveAspectRatio="none">${bars}${whole ? "" : `<line x1="${((cur + 0.5) / n) * 1000}" x2="${((cur + 0.5) / n) * 1000}" y1="0" y2="60" stroke="#EEF2EE" stroke-width="2" vector-effect="non-scaling-stroke"/>`}</svg>
      <input type="range" id="tl-r" min="0" max="${n - 1}" value="${cur}" aria-label="Week of the monsoon"></div>
    <div class="readout">${whole ? `<div class="w">Whole monsoon · <span class="wat">${Math.round(rainAll).toLocaleString("en-IN")} mm rain</span></div><div class="v">${inr(cum)} <span class="t3" style="font-size:13px">press play to watch it week by week</span></div>` : `<div class="w">Week of ${weekStart(S.week)} · <span class="wat">${Math.round(rn[S.week] || 0)} mm rain</span></div><div class="v">${inr(sp[S.week] || 0)} <span class="t3" style="font-size:13px">that week · ${inr(cum)} so far</span></div>`}</div></div>`);
  $("#tl-r").addEventListener("input", (e) => { stopPlay(); S.week = WEEKS[+e.target.value]; timeline(); jobsLayer(); });
  $("#tl-play").addEventListener("click", () => (playTimer ? stopPlay() : startPlay()));
  $("#dock").classList.add("below-tl");
}
function startPlay() {
  if (S.week == null || S.week === WEEKS[WEEKS.length - 1]) S.week = WEEKS[0];
  playTimer = setInterval(() => {
    const i = WEEKS.indexOf(S.week);
    if (i >= WEEKS.length - 1) { stopPlay(); S.week = null; timeline(); jobsLayer(); return; }
    S.week = WEEKS[i + 1]; timeline(); jobsLayer();
  }, 700);
  timeline(); jobsLayer();
}
function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; } }
function jobsLayer() {
  if (!mapReady) return;
  // city view stays calm: individual repairs appear inside a ward, or while the monsoon plays
  if (S.tab !== "trail" || (!S.ward && S.week == null)) { map.getSource("jobs").setData({ type: "FeatureCollection", features: [] }); return; }
  const feats = [];
  scopeWOs().forEach((w) => {
    const k = weekKey(w.completed_at); if (S.week != null && k > S.week) return;
    const p = roadMid(w.road_id); if (!p) return;
    feats.push(pt(jitter(w.work_order_id, p, 0.0016), { kind: "wo", id: w.work_order_id, now: S.week == null || k === S.week, pulse: S.week != null && k === S.week, flag: w.recoverable_inr > 0 }));
  });
  map.getSource("jobs").setData({ type: "FeatureCollection", features: feats });
  if (typeof floodNow === "function") { floodNow(); ripple(); }
}
function markSel(coord) {
  if (!mapReady) return;
  map.getSource("sel").setData({ type: "FeatureCollection", features: coord ? [pt(coord, {})] : [] });
}

/* ------------------------------------------------------------------ render */
function render() {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  syncHash();
  const R = { trail: railTrail, audit: railAudit, cards: railCards, plan: railPlan, ask: railAsk }[S.tab];
  $("#rail").innerHTML = "";
  R();
  dock();
  timeline();
  title();
  legend();
  overlay();
  mapMode();
  if (typeof roleCard === "function") roleCard();
  bindLinks(document.body);
  if (typeof visualMode === "function") { visualMode(); countUp($("#rail")); countUp($("#overlay")); }
}

function scope() {
  if (S.ward) return { ...WARD[S.ward], label: `Ward ${S.ward} · ${WARD[S.ward].ward_name.split(",")[0]}` };
  const T = D.totals;
  const sum = (k) => D.wards.reduce((s, w) => s + w[k], 0);
  return {
    label: "All Mumbai", budget_inr: T.budget_inr, spend_inr: T.spend_inr, spend_pct: (100 * T.spend_inr) / T.budget_inr,
    recoverable_inr: T.recoverable_inr, failed_spend_inr: T.failed_spend_inr, jobs: T.jobs, open_issues: T.issues_open,
    sla_met_pct: T.sla_met_pct, reopen_pct: T.reopen_pct, complaints: T.complaints,
    leak_breakdown: { dlp: sum("leak_breakdown") || D.wards.reduce((s, w) => s + w.leak_breakdown.dlp, 0) },
  };
}
const scopeWOs = () => D.work_orders.filter((w) => !S.ward || w.ward_code === S.ward);

function title() {
  const sc = scope();
  const t = {
    trail: [S.ward ? sc.label : "Follow the rupee", `${inr(sc.spend_inr)} spent on ${sc.jobs.toLocaleString("en-IN")} monsoon repairs · ${inr(sc.recoverable_inr)} to question`],
    audit: S.flag === "DLP_RECORDS_GAP" ? [`${auditRows().length} jobs to verify`, "Roads resurfaced since 2023 with no active DLP record · not counted as money"] : [`${auditRows().length} jobs to question`, `${inr(auditRows().reduce((s, w) => s + w.recoverable_inr, 0))} in ${S.ward ? sc.label : "Mumbai"} · each job counted once`],
    cards: ["Who delivered", "Contractors judged against what was expected for their wards, weather and targets"],
    plan: ["What to fix next", `${(S.ward ? D.plan_by_ward[S.ward].length : D.plan.length)} never-fixed issues in ${S.ward ? sc.label : "Mumbai"}, ranked by risk`],
    ask: ["What happened to my complaint?", "Trace any complaint to the job, the contractor, the bill and whether it held"],
  }[S.tab];
  $("#maptitle").innerHTML = `<h1>${esc(t[0])}</h1><p>${esc(t[1])}</p>`;
}

function legend() {
  const L = {
    trail: `${S.ward ? "" : `<div class="row"><i style="background:linear-gradient(#FF7A1A,#5A3A22);border-radius:3px;height:16px;width:10px"></i>Height: money to question</div>`}<div class="row"><i style="background:#F6EFDD;box-shadow:0 0 8px #F6EFDD;border-radius:2px;height:4px"></i>Road repaired 15+ times</div>${S.ward ? `<div class="row"><i style="background:#C9D2CC"></i>Repair</div><div class="row"><i style="background:#FF7A1A"></i>Repair with money to question</div>` : `<div class="row t3">Press play to see each repair</div>`}<div class="row"><i style="background:#4DB3E6;box-shadow:0 0 8px #4DB3E6"></i>Flood hotspot</div>`,
    audit: `<div class="row"><i style="background:#FF7A1A"></i>Flagged job, size = amount to question</div><div class="row"><i style="background:#5E7A6C;border-radius:2px;height:4px"></i>Road still under DLP</div><div class="row"><i style="background:#4DB3E6"></i>Flood hotspot</div>`,
    cards: `<div class="row"><i style="background:#6FD6A8"></i>Ward score 72+</div><div class="row"><i style="background:#F2C14E"></i>64 to 71</div><div class="row"><i style="background:#FF7A1A"></i>Below 64</div>`,
    plan: `<div class="row"><i style="background:#FF5A3C"></i>Risk 65+</div><div class="row"><i style="background:#FF7A1A"></i>50 to 64</div><div class="row"><i style="background:#F2C14E"></i>38 to 49</div><div class="row"><i style="background:#4A544E"></i>Beyond this budget</div><div class="row"><i style="border:2px solid #6FD6A8"></i>DLP road: ₹0 to BMC</div><div class="row"><i style="background:#4DB3E6;box-shadow:0 0 8px #4DB3E6"></i>Flood hotspot</div>`,
    ask: `<div class="row"><i style="background:#6FD6A8"></i>Fixed and held</div><div class="row"><i style="background:#FF7A1A"></i>Failed, flagged or never fixed</div>`,
  }[S.tab];
  $("#legend").innerHTML = L;
}

/* ---------------------------------------------------------- money trail */
function railTrail() {
  const sc = scope();
  const W = scopeWOs();
  const SURF = ["Pothole", "Broken paver blocks", "Road cave-in"];
  const dlpS = W.filter((w) => w.under_dlp === "Y" && SURF.includes(w.work_type)).reduce((s, w) => s + w.cost_inr, 0);
  const dlpD = W.filter((w) => w.under_dlp === "Y" && !SURF.includes(w.work_type)).reduce((s, w) => s + w.cost_inr, 0);
  const dup = W.filter((w) => w.duplicate_of).reduce((s, w) => s + w.cost_inr, 0);
  const over = W.filter((w) => w.cost_ratio > D.thresholds.overbill_review).reduce((s, w) => s + (w.cost_inr - w.expected_inr), 0);
  const maxL = Math.max(dlpS, dlpD, dup, over, 1);
  const leak = (k, n, v, tip) => `<div class="leak click" data-flag="${k}" title="${esc(tip)}"><span class="n">${n}</span><span class="a">${inr(v)}</span><div class="bar"><span style="width:${(100 * v) / maxL}%"></span></div></div>`;
  rail(`<div class="card"><div class="card-h"><h3>Money to question</h3><span class="badge acc">${pct((100 * sc.recoverable_inr) / sc.spend_inr)} of spend</span></div>
    <div class="big">${bigInr(sc.recoverable_inr)}</div>
    <div class="sub">of ${inr(sc.spend_inr)} spent${S.ward ? ` in ward ${esc(S.ward)}` : ""}. Tap a line for the receipts.</div>
    <div style="margin-top:8px">
    ${leak("DLP_PAID:surface", "Paid during DLP · road surface", dlpS, "Defects in roads still under the original contractor's guarantee")}
    ${leak("DLP_PAID:drainage", "Paid during DLP · drains and pumps", dlpD, "Work on guaranteed roads, to check against each DLP contract")}
    ${leak("DUPLICATE", "Billed twice", dup, "Copies of an earlier job with no complaint behind them")}
    ${leak("OVERBILLED", "Over the rate card", over, "Excess above the rate card on jobs over 1.30x")}</div></div>`);

  const SR = D.totals.same_roads;
  const segs = D.same_roads.filter((s) => !S.ward || s.ward_code === S.ward);
  const segSpend = segs.reduce((a, s) => a + s.spend_inr, 0);
  rail(`<div class="card"><div class="card-h"><h3>The same roads, again and again</h3><span class="badge hot">${segs.length} segment${segs.length === 1 ? "" : "s"}</span></div>
    ${segs.length ? `<div class="big">${Math.round((100 * segSpend) / sc.spend_inr)}<span class="u">% of spend</span></div>
    <div class="sub">on roads repaired ${SR.min_jobs}+ times in one monsoon. Each patch held a month; the road did not.</div>
    <div class="list" style="margin-top:12px">${segs.slice(0, S.ward ? 4 : 3).map((s) => roadItem(s)).join("")}</div>` : `<div class="sub">No road here was repaired ${SR.min_jobs}+ times this monsoon.</div>`}</div>`);

  const RF = S.ward ? { failed: sc.resolved_failed, resolved: sc.resolved } : D.totals.resolved_failed;
  const CU = S.ward ? sc.closed_unfixed : D.totals.closed_unfixed.on_bmc_paid_roads;
  rail(`<div class="card"><h3>Did the fix last?</h3>
    <div class="tiles">
      <div><div class="mid">${(100 - sc.reopen_pct).toFixed(0)}<span class="u">%</span></div><div class="k">of fixes held 30 days</div></div>
      <div><div class="mid acc">${RF.failed.toLocaleString("en-IN")}</div><div class="k">"Resolved" but the fix failed</div></div>
      <div><div class="mid warn">${CU.toLocaleString("en-IN")}</div><div class="k">closed as someone else's road</div></div>
    </div>
    <details class="more"><summary>What these mean</summary><div class="sub">${pct((100 * RF.failed) / Math.max(RF.resolved, 1))} of complaints marked Resolved were linked to a fix that failed within 30 days; the citizen still sees "Resolved". ${CU} complaints were closed as "Not BMC road" or sent to MMRDA/PWD, yet sit on roads BMC itself repairs: verify jurisdiction. Only ${pct(D.totals.sla24_met_pct)} of 24 h targets are met city-wide.</div></details></div>`);

  const max = Math.max(sc.budget_inr, sc.spend_inr);
  const overB = sc.spend_inr > sc.budget_inr;
  rail(`<div class="card"><div class="card-h"><h3>Budget vs spend</h3><span class="badge ${overB ? "warnb" : "ok"}">${overB ? `${pct(sc.spend_pct - 100, 1)} over` : `${pct(100 - sc.spend_pct, 1)} unspent`}</span></div>
    <div class="mid">${bigInr(sc.spend_inr)}<span class="u">of ${inr(sc.budget_inr)}</span></div>
    <div class="seg"><div class="s" style="width:${(100 * sc.spend_inr) / max}%"></div><div class="h" style="width:${(100 * sc.failed_spend_inr) / max}%"></div><div class="m" style="left:calc(${(100 * sc.budget_inr) / max}% - 1px)"></div></div>
    <div class="ticks"><span>hatched: ${inr(sc.failed_spend_inr)} on fixes that failed</span><span>budget</span></div></div>`);

  const Sf = D.totals.safety;
  rail(`<div class="card alert"><h3>Delay is dangerous</h3><div class="mid" style="margin-top:8px">${Sf.defect_ratio}<span class="u">x more road-defect accidents</span></div><div class="sub">while a complaint about that road is unresolved. Other accidents rise only ${Sf.other_ratio}x.</div></div>`);

  if (S.ward) {
    const so = sc.social || {};
    const soN = Object.values(so).reduce((a, b) => a + b, 0);
    if (sc.no_panel) rail(`<div class="card"><h3>No empanelled contractor</h3><div class="sub">contractors.csv lists none for ward ${esc(S.ward)}, yet every job here was awarded. A records question for BMC, not a mark against anyone.</div></div>`);
    rail(`<div class="card"><div class="card-h"><h3>Claude's one-pager</h3><button class="btn" id="narr-btn">Rewrite</button></div><details class="more" open><summary>For the corporator and citizens of ward ${esc(S.ward)}</summary><div class="narr" id="narr">Loading…</div></details></div>`);
    narrate("ward", S.ward, $("#narr"), $("#narr-btn"), true);
    $("#narr-btn").onclick = () => narrate("ward", S.ward, $("#narr"), $("#narr-btn"), false, true);
    if (soN) rail(`<div class="card"><div class="card-h"><h3>What residents are posting</h3><span class="badge">${soN}</span></div><div class="chips">${Object.entries(so).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip static">${esc(k)}<span class="n">${v}</span></span>`).join("")}</div></div>`);
  } else {
    rail(`<div class="card"><h3>Open a ward</h3><div class="list" style="margin-top:10px">${[...D.wards].sort((a, b) => b.recoverable_inr - a.recoverable_inr).slice(0, 5).map((w) => `<div class="item" data-ward="${w.ward_code}"><span class="rk">${w.ward_code}</span><div><div class="w">${esc(w.ward_name.split(",")[0])}</div><div class="s">${pct((100 * w.recoverable_inr) / w.spend_inr)} of spend to question</div></div><div class="c acc">${inr(w.recoverable_inr)}</div></div>`).join("")}</div></div>`);
  }
  $$("#rail [data-flag]").forEach((el) => el.addEventListener("click", () => { S.flag = el.dataset.flag; go("audit"); }));
  $$("#rail [data-road]").forEach((el) => el.addEventListener("click", () => showRoad(el.dataset.road, true)));
  $$("#rail [data-ward]").forEach((el) => el.addEventListener("click", () => selectWard(el.dataset.ward)));
}

function roadItem(s) {
  return `<div class="item" data-road="${s.road_id}"><span class="rk hotk">${s.jobs}</span><div><div class="w">${esc(s.road_name)} <span class="t3">${S.ward ? "" : s.ward_code}</span></div><div class="s">${s.road_id} · ${s.length_m} m · ${s.failed} failed${s.under_dlp ? " · under DLP" : ""}</div></div><div class="c">${inr(s.spend_inr)}</div></div>`;
}
const ISL = new Set(["A", "B", "C", "D", "E", "F/S", "F/N", "G/S", "G/N"]);
const isIsland = (w) => ISL.has(w);

function weekKey(d) { const t = new Date(d.replace(" ", "T")); const j = new Date(t.getFullYear(), 0, 1); return Math.floor((t - j) / 6048e5); }
function rainChart(W) {
  const st = S.ward && isIsland(S.ward) ? "Colaba" : "Santacruz";
  const wk = {}, rk = {};
  W.forEach((w) => { const k = weekKey(w.completed_at); wk[k] = (wk[k] || 0) + w.cost_inr; });
  D.map.rain.forEach((r) => { const k = weekKey(r.date); rk[k] = (rk[k] || 0) + r[st]; });
  const keys = Object.keys(rk).map(Number).sort((a, b) => a - b);
  const mx = Math.max(...keys.map((k) => wk[k] || 0), 1), mr = Math.max(...keys.map((k) => rk[k]), 1);
  const Wd = 340, H = 120, bw = Wd / keys.length;
  const bars = keys.map((k, i) => { const h = ((wk[k] || 0) / mx) * (H - 18); return `<rect x="${i * bw + 1.5}" y="${H - h}" width="${bw - 3}" height="${h}" rx="2" fill="#2E3D35"/>`; }).join("");
  const line = keys.map((k, i) => `${i ? "L" : "M"}${(i + 0.5) * bw},${H - (rk[k] / mr) * (H - 18)}`).join("");
  const top = keys.reduce((a, k) => (rk[k] > rk[a] ? k : a), keys[0]);
  const ti = keys.indexOf(top);
  return `<svg class="spark" viewBox="0 0 ${Wd} ${H + 4}" preserveAspectRatio="none">${bars}<path d="${line}" fill="none" stroke="#4DB3E6" stroke-width="2"/><circle cx="${(ti + 0.5) * bw}" cy="${H - (rk[top] / mr) * (H - 18)}" r="4" fill="#4DB3E6" stroke="#090D0B" stroke-width="2"/></svg>
    <div class="ticks"><span>Jun</span><span class="wat">peak week ${Math.round(rk[top])} mm</span><span>Sep</span></div>`;
}
function weekBars(W) {
  const g = {};
  W.forEach((w) => { const k = weekKey(w.completed_at); (g[k] = g[k] || [0, 0]); g[k][0]++; if (w.reopened_within_30d === "N") g[k][1]++; });
  const keys = Object.keys(g).map(Number).sort((a, b) => a - b);
  return `<div class="mini" style="margin-top:12px" title="Share of each week's fixes that held">${keys.map((k) => { const r = g[k][1] / g[k][0]; return `<span class="${r >= 0.8 ? "hi" : ""}" style="height:${Math.max(r * 100, 4)}%"></span>`; }).join("")}</div><div class="ticks"><span>Jun</span><span>weeks where 80%+ held are green</span><span>Oct</span></div>`;
}

/* ---------------------------------------------------------- auditor */
function auditRows() {
  const [fc, fk] = S.flag.split(":");
  return scopeWOs().filter((w) => w.flags.some((f) => (fc === "ALL" ? isMoney(f) : f.code === fc) && (fc === "ALL" || (f.code === fc && (!fk || f.kind === fk))))).sort((a, b) => b.recoverable_inr - a.recoverable_inr);
}
function railAudit() {
  const W = scopeWOs();
  const cnt = (fn) => W.filter((w) => w.flags.some(fn));
  const chips = [
    ["ALL", "All flagged", cnt(isMoney)],
    ["DLP_PAID:surface", "DLP · road surface", cnt((f) => f.code === "DLP_PAID" && f.kind === "surface")],
    ["DLP_PAID:drainage", "DLP · drains and pumps", cnt((f) => f.code === "DLP_PAID" && f.kind === "drainage")],
    ["DUPLICATE", "Billed twice", cnt((f) => f.code === "DUPLICATE")],
    ["OVERBILLED", "Over rate card", cnt((f) => f.code === "OVERBILLED")],
    ["DLP_RECORDS_GAP", "Verify: DLP records gap", cnt((f) => f.code === "DLP_RECORDS_GAP")],
  ];
  rail(`<div class="card"><h3>Filter the audit</h3><div class="chips" style="margin-top:12px">${chips.map(([c, l, rows]) => `<button class="chip ${S.flag === c ? "on" : ""}" data-c="${c}">${l}<span class="n">${rows.length}</span></button>`).join("")}</div>
    <div class="sub t3" style="font-size:12.5px">Re-opens and missed SLAs show on every job but never count as money to question.</div></div>`);
  const V = { found: ["found", "Found"], verify: ["verify", "Verify"], "not found": ["not", "Ruled out"] };
  rail(`<div class="card"><div class="card-h"><h3>What we looked for</h3><span class="badge">${D.investigation.length} checks</span></div>
    <div class="sub t3" style="margin:0 0 6px;font-size:12.5px">Every hypothesis for the three hidden problems, and the number that decided it.</div>
    ${D.investigation.map((r) => `<div class="inv"><span class="vt ${V[r.verdict][0]}">${V[r.verdict][1]}</span><span><b>${esc(r.test)}</b><span class="r">${esc(r.result)}</span></span></div>`).join("")}</div>`);
  $$("#rail .chip").forEach((b) => b.addEventListener("click", () => { S.flag = b.dataset.c; S.shown = 40; render(); }));
}

/* ---------------------------------------------------------- dock */
function dock() {
  const d = $("#dock");
  d.className = "dock glass" + (S.tab === "trail" && !S.dockOpen ? " min" : "");
  if (S.tab === "audit" || (S.tab === "trail" && S.ward)) {
    const rows = auditRows();
    const tot = rows.reduce((s, w) => s + w.recoverable_inr, 0);
    d.innerHTML = `<div class="dock-h"><h3>Flagged work orders</h3>${S.flag === "DLP_RECORDS_GAP" ? `<span class="badge warnb">${rows.length} jobs · verify, not counted</span>` : `<span class="badge acc">${rows.length} jobs · ${inr(tot)}</span>`}<span class="sp"><button class="btn" id="dock-min">Minimise</button><button class="btn light" id="csv">Export CSV</button></span></div>
      <div class="dock-b"><table class="tbl"><thead><tr><th>Work order</th><th>Ward</th><th>Contractor</th><th>Job</th><th>Offset</th><th>Why it is flagged</th><th style="text-align:right">Billed</th><th style="text-align:right">To question</th></tr></thead><tbody>
      ${rows.slice(0, S.shown).map((w) => `<tr class="click" data-wo="${w.work_order_id}"><td class="id">${w.work_order_id}</td><td>${w.ward_code}</td><td>${esc(w.contractor_name)}</td><td>${esc(w.repair_method)}<div class="t3">${esc(w.road_name)}</div></td><td>${offsets(w)}</td><td class="why">${esc((S.flag.startsWith("DLP_RECORDS_GAP") ? w.flags.find((f) => f.code === "DLP_RECORDS_GAP") : topFlags(w)[0])?.why)}</td><td class="num">${inr(w.cost_inr, false)}</td><td class="num acc">${inr(w.recoverable_inr, false)}</td></tr>`).join("")}
      </tbody></table>${rows.length > S.shown ? `<div style="padding:10px"><button class="btn" id="more">Show ${Math.min(60, rows.length - S.shown)} more</button></div>` : ""}</div>`;
    $("#csv").onclick = () => csv(rows);
    $("#dock-min").onclick = () => { d.classList.toggle("min"); S.dockOpen = !d.classList.contains("min"); $("#dock-min").textContent = d.classList.contains("min") ? "Expand" : "Minimise"; };
    if (d.classList.contains("min")) $("#dock-min").textContent = "Expand";
    $("#more")?.addEventListener("click", () => { S.shown += 60; dock(); bindLinks(d); });
  } else if (S.tab === "trail") {
    const w = D.wards;
    const C = [...D.contractors].sort((a, b) => b.spend_inr - a.spend_inr), mC = C[0].spend_inr;
    const M = {}; D.work_orders.forEach((x) => { const m = (M[x.repair_method] = M[x.repair_method] || [0, 0, 0]); m[0] += x.cost_inr; m[1]++; if (x.reopened_within_30d === "Y") m[2]++; });
    const Ms = Object.entries(M).sort((a, b) => b[1][0] - a[1][0]), mM = Ms[0][1][0];
    const over = w.filter((x) => x.spend_pct > 100).sort((a, b) => b.spend_pct - a.spend_pct);
    d.innerHTML = `<div class="dock-h"><h3>Where the money went</h3><span class="t3" style="font-size:12.5px">Click a ward on the map for its own trail</span><span class="sp"><button class="btn" id="dock-min">Minimise</button></span></div>
      <div class="dock-b"><div class="split">
      <div><h3 style="margin-bottom:10px">By contractor</h3>${C.map((c) => `<div class="brow"><div class="t"><span>${esc(c.name)} <span class="gb g-${c.grade}">grade ${c.grade}</span></span><b>${inr(c.spend_inr)}</b></div><div class="b"><span style="width:${(100 * c.spend_inr) / mC}%"></span></div></div>`).join("")}</div>
      <div><h3 style="margin-bottom:10px">By repair method · failed in 30 days</h3>${Ms.map(([m, v]) => `<div class="brow"><div class="t"><span>${esc(m)} <span class="t3">· ${pct((100 * v[2]) / v[1])} failed</span></span><b>${inr(v[0])}</b></div><div class="b"><span style="width:${(100 * v[0]) / mM}%"></span></div></div>`).join("")}</div>
      <div><h3 style="margin-bottom:10px">Wards over budget</h3>${over.map((x) => `<div class="brow link" data-ward="${x.ward_code}"><div class="t"><span>${x.ward_code} · ${esc(x.ward_name.split(",")[0])}</span><b class="acc">${pct(x.spend_pct - 100, 1)} over</b></div><div class="b"><span class="bad" style="width:${Math.min(100, (x.spend_pct - 100) * 5)}%"></span></div></div>`).join("")}
      <div class="sub t3" style="font-size:12.5px;margin-top:12px">${D.wards.length - over.length} wards stayed within budget.</div></div>
      </div></div>`;
    $("#dock-min").onclick = () => { d.classList.toggle("min"); S.dockOpen = !d.classList.contains("min"); $("#dock-min").textContent = d.classList.contains("min") ? "Expand" : "Minimise"; };
    if (d.classList.contains("min")) $("#dock-min").textContent = "Expand";
    $$("#dock [data-ward]").forEach((el) => el.addEventListener("click", () => selectWard(el.dataset.ward)));
  } else {
    d.className = "dock glass hidden";
    d.innerHTML = "";
  }
}
const isMoney = (f) => f.level === "high" || f.level === "review";
function topFlags(w) { return w.flags.filter(isMoney); }
function offsets(w) {
  const o = [];
  if (w.cost_ratio > D.thresholds.overbill_review) o.push(`<span class="off">${w.cost_ratio.toFixed(2)}x rate</span>`);
  if (w.under_dlp === "Y") o.push(`<span class="off">DLP</span>`);
  if (w.duplicate_of) o.push(`<span class="off">twin</span>`);
  if (w.hours_taken != null) o.push(w.hours_taken > w.sla_hours ? `<span class="off n">+${Math.round(w.hours_taken - w.sla_hours)} h</span>` : `<span class="off ok">on time</span>`);
  return o.join(" ");
}
function csv(rows) {
  const cols = ["work_order_id", "ward_code", "road_id", "road_name", "contractor_name", "work_type", "repair_method", "area_sqm", "cost_inr", "expected_inr", "cost_ratio", "under_dlp", "duplicate_of", "sla_hours", "hours_taken", "reopened_within_30d", "recoverable_inr"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = [cols.concat("flags", "why").join(","), ...rows.map((w) => cols.map((c) => q(w[c])).concat(q(topFlags(w).map((f) => f.code).join("|")), q(topFlags(w)[0]?.why)).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
  a.download = `marg-flags-${S.ward ? S.ward.replace("/", "-") : "mumbai"}-${S.flag.replace(":", "-").toLowerCase()}.csv`;
  a.click();
}

/* ---------------------------------------------------------- scorecards */
function railCards() {
  rail(`<div class="card"><h3>Fair by design</h3><div class="sub">Every contractor and every ward is compared with what was expected for its own roads, rain, flood risk and targets, never with a raw average.</div>
    <details class="more"><summary>How expectations are set</summary><div class="sub">For every job, two models predict, from things the contractor does not control, how likely the fix was to fail and to meet its target. The 24 h target is met ${pct(D.totals.sla24_met_pct)} of the time city-wide, so raw on-time rates would punish whoever got the urgent jobs. Billing uses rates, so more work is never a penalty.</div></details></div>`);
  rail(`<div class="card"><h3>Contractors</h3><div class="list" style="margin-top:10px">${D.contractors.map((c) => `<div class="item" data-ct="${c.contractor_id}"><span class="rk g-${c.grade}">${c.grade}</span><div><div class="w">${esc(c.name)}</div><div class="s">${c.score}/100 · ${c.jobs} jobs · ${inr(c.spend_inr)}</div></div><div class="c">${c.reopen_oe}x<div class="s">failures vs expected</div></div></div>`).join("")}</div></div>`);
  $$("#rail [data-ct]").forEach((el) => el.addEventListener("click", () => { if (S.cardView === "wards") { S.cardView = "contractors"; overlay(); bindLinks($("#overlay")); } document.getElementById("ct-" + el.dataset.ct)?.scrollIntoView({ behavior: "smooth", block: "center" }); }));
}
function meter(label, score, color, note, mark) {
  return `<div class="meter"><div class="t"><span>${label}</span><span>${note}</span></div><div class="b"><span style="width:${score}%;background:${color}"></span>${mark != null ? `<i style="left:${mark}%"></i>` : ""}</div></div>`;
}
/* expected vs actual on one 0..100% scale: a ring for what was expected, a dot for what happened */
function dumbbell(label, actual, expected, higherIsBetter, note) {
  const better = higherIsBetter ? actual >= expected : actual <= expected;
  // same band as the verdict sentences: within 15% of what was expected counts as "as expected"
  const near = expected > 0 ? Math.abs(actual / expected - 1) < 0.15 : Math.abs(actual - expected) < 2;
  const col = near ? "#B7C0BA" : better ? "#6FD6A8" : "#FF7A1A";
  const lo = Math.min(actual, expected), hi = Math.max(actual, expected);
  const word = near ? "as expected" : better ? "better than expected" : "worse than expected";
  return `<div class="db"><div class="db-h"><span>${label}</span><span style="color:${col}">${word}</span></div>
    <div class="db-track"><span class="db-gap" style="left:${lo}%;width:${hi - lo}%;background:${col}"></span><i class="db-exp" style="left:${expected}%"></i><i class="db-act" style="left:${actual}%;background:${col}"></i></div>
    <div class="db-l"><span>${note(actual)} actual</span><span class="t3">${note(expected)} expected</span></div></div>`;
}
function ctVerdict(c) {
  const sp = c.sla_oe >= 1.15 ? "finishes on time more often than expected" : c.sla_oe <= 0.85 ? "misses its targets more often than expected" : "is on time about as often as expected";
  const du = c.reopen_oe <= 0.85 ? "its fixes last longer than expected" : c.reopen_oe >= 1.15 ? "its fixes fail more often than expected" : "its fixes fail about as often as expected";
  const bi = c.overbilled_jobs >= 20 ? `${c.overbilled_jobs} of its bills sit well above the rate card` : c.overbilled_jobs + c.duplicate_jobs > 0 ? "a few bills need checking" : "no bills sit above the rate card";
  return `${esc(c.name.split(" ")[0])} ${sp}, ${du}, and ${bi}.`;
}
function wardVerdict(w) {
  const spend = w.spend_pct > 100 ? `overspent its budget by ${pct(w.spend_pct - 100, 1)}` : `used ${pct(w.spend_pct)} of its budget`;
  const du = w.reopen_oe <= 0.85 ? "fixes lasted longer than its conditions predict" : w.reopen_oe >= 1.15 ? "fixes failed more than its conditions predict" : "fixes held about as well as its conditions predict";
  return `Ward ${esc(w.ward_code)} ${spend}; ${du}. ${w.open_issues} issue${w.open_issues === 1 ? "" : "s"} still wait for a fix.`;
}
function billBar(c) {
  const over = c.overbilled_jobs, dup = c.duplicate_jobs, dlp = c.dlp_paid_jobs, clean = Math.max(c.jobs - over - dup, 0);
  const seg = (n, col, t) => n ? `<span title="${t}: ${n}" style="flex:${n};background:${col}"></span>` : "";
  return `<div class="bb">${seg(clean, "#3C4A43", "Within the rate card")}${seg(over, "#FF7A1A", "Over the rate card")}${seg(dup, "#FFB27A", "Billed twice")}</div>
    <div class="db-l"><span>${over} over rate · ${dup} billed twice · ${dlp} on DLP roads</span><span class="acc">${inr(c.recoverable_inr)}</span></div>`;
}
function overlay() {
  const o = $("#overlay");
  if (S.tab !== "cards") { o.hidden = true; o.innerHTML = ""; return; }
  o.hidden = false;
  const view = S.cardView || "contractors";
  const sw = `<div class="ov-head"><div class="seg2" role="tablist"><button class="${view === "contractors" ? "on" : ""}" data-view="contractors">Contractors · 8</button><button class="${view === "wards" ? "on" : ""}" data-view="wards">Wards · 24</button></div>
    <span class="t3">Ring: what was expected for these roads, wards, rain and targets. Dot: what happened.</span></div>`;
  let body = "";
  if (view === "contractors") {
    body = `<div class="ov-grid">${D.contractors.map((c) => `<div class="glass ct" id="ct-${c.contractor_id}">
      <div class="ct-top"><div><div class="ct-name">${esc(c.name)}</div><div class="t3 ct-meta">${c.jobs} jobs · ${inr(c.spend_inr)} · since ${c.empanelled_since}</div></div><span class="grade g-${c.grade}">${c.grade}</span></div>
      <div class="verdict">${ctVerdict(c)}</div>
      ${dumbbell("On time", c.sla_met_pct, c.expected_sla_pct, true, (v) => pct(v))}
      ${dumbbell("Fixes that failed in 30 days", c.reopen_pct, c.expected_reopen_pct, false, (v) => pct(v))}
      <div class="db"><div class="db-h"><span>Billing</span><span class="t3">${c.score}/100 overall</span></div>${billBar(c)}</div>
      ${c.citizen_quotes.length ? `<div class="cq">“${esc(c.citizen_quotes[0].text.replace(/\s*🙄.*$/, "…"))}”<div class="t3">Social post ${c.citizen_quotes[0].post_id} (synthetic), ${c.citizen_quotes[0].days_after} days after <span class="link id" data-wo="${c.citizen_quotes[0].work_order_id}">${c.citizen_quotes[0].work_order_id}</span>, the only failed fix on that road that week</div></div>` : ""}
      <div class="ct-foot"><span class="t3">Evidence</span> ${[...c.evidence.overbilled.slice(0, 2), ...c.evidence.duplicates.slice(0, 1)].map((id) => `<span class="link id" data-wo="${id}">${id}</span>`).join(" ") || '<span class="t3">no billing flags</span>'}</div>
      <div class="narr" id="cn-${c.contractor_id}"></div>
      <button class="btn" data-narr="${c.contractor_id}">Claude's scorecard for citizens</button></div>`).join("")}</div>`;
  } else {
    const ws = [...D.wards].sort((a, b) => b.score - a.score);
    body = `<div class="ov-grid">${ws.map((w, i) => {
      const max = Math.max(w.budget_inr, w.spend_inr);
      return `<div class="glass ct wd" id="wd-${w.ward_code.replace("/", "-")}">
      <div class="ct-top"><div><div class="ct-name">${esc(w.ward_code)} · ${esc(w.ward_name.split(",")[0])}</div><div class="t3 ct-meta">${(w.population / 1e5).toFixed(1)} lakh people · low-lying index ${w.low_lying_index} of 1</div></div><span class="rankb">#${i + 1}<small>${w.score}</small></span></div>
      <div class="verdict">${wardVerdict(w)}</div>
      <div class="db"><div class="db-h"><span>Budget</span><span class="${w.spend_pct > 100 ? "warn" : "t3"}">${pct(w.spend_pct)} used</span></div>
        <div class="seg sm"><div class="s" style="width:${(100 * w.spend_inr) / max}%"></div><div class="h" style="width:${(100 * w.failed_spend_inr) / max}%"></div><div class="m" style="left:calc(${(100 * w.budget_inr) / max}% - 1px)"></div></div>
        <div class="db-l"><span>${inr(w.spend_inr)} of ${inr(w.budget_inr)}</span><span class="acc">${inr(w.recoverable_inr)} to question</span></div></div>
      ${dumbbell("On time", w.sla_met_pct, w.expected_sla_pct, true, (v) => pct(v))}
      ${dumbbell("Fixes that failed in 30 days", w.reopen_pct, w.expected_reopen_pct, false, (v) => pct(v))}
      <div class="wstats"><div><b>${w.open_issues}</b><span>never fixed</span></div><div><b>${w.resolved_failed}</b><span>"resolved", then failed</span></div><div><b>${w.chronic_segments.length}</b><span>roads fixed 15+ times</span></div></div>
      <button class="btn" data-openward="${w.ward_code}">Open the ward's money trail</button></div>`; }).join("")}</div>`;
  }
  o.innerHTML = `<div class="ov">${sw}${body}</div>`;
  $$("#overlay [data-view]").forEach((b) => b.addEventListener("click", () => { S.cardView = b.dataset.view; overlay(); bindLinks($("#overlay")); if (typeof countUp === "function") countUp($("#overlay")); }));
  $$("#overlay [data-openward]").forEach((b) => b.addEventListener("click", () => { S.tab = "trail"; selectWard(b.dataset.openward); }));
  $$("#overlay [data-narr]").forEach((b) => {
    const el = $("#cn-" + b.dataset.narr);
    narrate("contractor", b.dataset.narr, el, b, true, false);
    b.addEventListener("click", () => {
      if (el.textContent && el.classList.contains("open")) { el.classList.remove("open"); b.textContent = "Claude's scorecard for citizens"; return; }
      if (el.textContent) { el.classList.add("open"); b.textContent = "Hide Claude's scorecard"; return; }
      narrate("contractor", b.dataset.narr, el, b, false, false, () => el.classList.add("open"));
    });
    el.classList.remove("open");
  });
}

/* ---------------------------------------------------------- next rupee */
const PART = { severity: ["#FF5A3C", "Severity of the issue type (average SLA tier BMC gave it in 2025)"], demand: ["#F2C14E", "Complaints and me-too votes"], flood: ["#4DB3E6", "Nearby flood spot: days in 2025 the rain crossed its threshold, big tides, years flagged"], traffic: ["#B7C0BA", "Peak traffic and BEST buses"], accidents: ["#FF7A1A", "Road-defect accidents on that road"], access: ["#6FD6A8", "Ambulance route to a hospital or school access"], repeat: ["#5E7A6C", "Past fixes on that road that failed"] };
function planTags(p) {
  const t = [`${p.complaints} complaint${p.complaints > 1 ? "s" : ""}`];
  if (p.road_id && CHRONIC[p.road_id]) t.push(`road fixed ${CHRONIC[p.road_id].jobs}x`);
  const r = p.risk_parts;
  if (r.flood >= 6) t.push("flood spot");
  if (r.accidents >= 4) t.push("accidents here");
  if (r.access >= 4) t.push(p.reasons.some((x) => x.startsWith("ambulance")) ? "hospital route" : "school route");
  if (r.traffic >= 8) t.push("heavy traffic");
  return t.slice(0, 4).join(" · ");
}
function defaultBudget() {
  const ws = S.ward ? [WARD[S.ward]] : D.wards;
  const unspent = ws.reduce((s, w) => s + Math.max(w.budget_inr - w.spend_inr, 0), 0);
  const rec = ws.reduce((s, w) => s + w.recoverable_inr, 0);
  return { unspent, rec, total: unspent > 0 ? Math.round(unspent / 10000) * 10000 : 500000 };
}
function planItems() {
  if (S.budget == null) S.budget = defaultBudget().total;
  const items = S.ward ? D.plan_by_ward[S.ward].map((i) => PLAN[i]) : D.plan;
  let used = 0;
  return items.map((p) => { const fits = used + p.est_cost_inr <= S.budget; if (fits) used += p.est_cost_inr; return { p, fits, used }; });
}
function railPlan() {
  const db = defaultBudget();
  const items = planItems();
  const n = items.filter((x) => x.fits).length, used = items.filter((x) => x.fits).reduce((s, x) => s + x.p.est_cost_inr, 0);
  const free = items.filter((x) => x.p.dlp_note).length;
  rail(`<div class="card"><div class="card-h"><h3>Budget for the backlog</h3><span class="badge ${db.unspent > 0 ? "ok" : "acc"}">${db.unspent > 0 ? `${inr(db.unspent)} unspent` : "over budget"}</span></div>
    <div class="field"><span class="t3">₹</span><input id="budget" type="number" step="50000" min="0" value="${S.budget}"></div>
    <div class="sub t3" style="font-size:12.5px">${db.unspent > 0 ? "Default is the unspent 2025 budget." : "Overspent, so the default is ₹5 L."} Recovering the flagged money could add ${inr(db.rec)}.</div>
    <div class="kv"><div><div class="k">Fits</div><div class="v">${n} of ${items.length}</div></div><div><div class="k">Uses</div><div class="v">${inr(used)}</div></div><div><div class="k">₹0 via DLP</div><div class="v okc">${free}</div></div></div></div>`);
  rail(`<div class="card"><h3>Fix these first</h3><div class="list" style="margin-top:10px">${items.slice(0, 40).map(({ p, fits }, i) => `<div class="item ${fits ? "" : "out"} ${S.issue === p.issue_id ? "on" : ""}" data-issue="${p.issue_id}"><span class="rk" style="${p.risk >= 65 ? "background:rgba(255,90,60,.2);color:#FF9078" : p.risk >= 50 ? "background:var(--accent-soft);color:#FFB27A" : ""}">${i + 1}</span>
    <div><div class="w">${esc(p.issue_type)} · ${esc(p.road_name || p.locality || "location unclear")}${S.ward ? "" : ` <span class="t3">${p.ward_code}</span>`}</div><div class="s">${esc(planTags(p))}</div><div class="riskbar">${Object.entries(p.risk_parts).map(([k, v]) => `<span style="width:${v}%;background:${PART[k][0]}"></span>`).join("")}</div></div>
    <div class="c">${p.dlp_note ? '<span class="okc">₹0</span>' : inr(p.est_cost_inr)}<div class="s">risk ${Math.round(p.risk)}</div></div></div>`).join("")}</div>${items.length > 40 ? `<div class="sub t3" style="font-size:12px">Top 40 of ${items.length} shown. All are on the map.</div>` : ""}</div>`);
  if (!S.ward) {
    const WS = D.ward_split;
    const mx = Math.max(...WS.rows.map((r) => Math.abs(r.change_pct)));
    rail(`<div class="card"><div class="card-h"><h3>Next season, split by need</h3><span class="badge">${inr(WS.total)}</span></div>
      <div class="sub" style="margin-top:0">The same total, shared by what each ward's work should have cost in 2025 plus its never-fixed backlog. DLP fixes are left out: contractors owe those.</div>
      <div style="margin-top:10px">${WS.rows.map((r) => `<div class="brow link" data-ward="${r.ward_code}" style="cursor:pointer"><div class="t"><span>${r.ward_code} · ${esc(r.ward_name.split(",")[0])}</span><b class="${r.change > 0 ? "okc" : "t2"}">${r.change > 0 ? "+" : ""}${pct(r.change_pct)} · ${inr(r.suggested)}</b></div><div class="b"><span style="width:${(100 * Math.abs(r.change_pct)) / mx}%;background:${r.change > 0 ? "var(--ok)" : "#4A544E"}"></span></div></div>`).join("")}</div></div>`);
  }
  const cu = D.closed_unfixed.filter((x) => !S.ward || x.ward_code === S.ward);
  const cuN = S.ward ? WARD[S.ward].closed_unfixed : D.totals.closed_unfixed.on_bmc_paid_roads;
  rail(`<div class="card"><div class="card-h"><h3>Closed without a fix</h3><span class="badge" style="background:rgba(242,193,78,.14);color:var(--warn)">verify</span></div>
    <div class="sub" style="margin-top:0">${cuN} complaint${cuN === 1 ? " was" : "s were"} closed as "Not BMC road" or forwarded to MMRDA/PWD, yet they sit on segments BMC itself repairs and pays for. Not in the ranking above until jurisdiction is confirmed.</div>
    <div class="list" style="margin-top:10px">${cu.slice(0, 8).map((x) => { const r = ROAD[x.road_id]; return `<div class="item" data-closed="${x.road_id}|${x.issue_type}"><span class="rk">${x.complaints}</span><div><div class="w">${esc(x.issue_type)} · ${esc(r ? r.name : x.road_id)}${S.ward ? "" : ` <span class="t3">${x.ward_code}</span>`}</div><div class="s">${Object.entries(x.statuses).map(([k, v]) => `${v} ${k.replace("Rejected - ", "").replace("Forwarded to ", "to ")}`).join(" · ")} · BMC spent ${inr(x.bmc_spend_on_road_inr)} on this road</div></div><div class="c"></div></div>`; }).join("")}</div>
    ${cu.length > 8 ? `<div class="sub t3" style="font-size:12px">Top 8 of ${cu.length} shown.</div>` : ""}</div>`);
  rail(`<div class="card"><h3>How risk is scored</h3><div style="margin-top:10px;display:grid;gap:7px;font-size:12.5px">${Object.entries(PART).map(([k, [c, t]]) => `<div class="row" style="display:flex;gap:8px"><i style="width:10px;height:10px;border-radius:3px;background:${c};flex:none;margin-top:3px"></i><span class="t2">${t}</span></div>`).join("")}</div></div>`);
  rail(`<div class="card"><h3>Pay for fixes that last</h3><div class="sub t3" style="font-size:12.5px">Share of fixes that held 30 days, and cost per fix that held. The most durable method wins unless it costs over 1.5x the cheapest.</div>${Object.entries(D.method_economics).map(([t, opts]) => `<div style="margin-top:12px"><div class="t3" style="font-size:12px">${esc(t)}</div>${opts.map((o) => `<div class="brow" style="margin:6px 0 0"><div class="t"><span>${o.recommended ? '<span class="okc">★</span> ' : ""}${esc(o.method)}</span><b>${pct(o.holds_pct)} · ${inr(o.cost_per_durable_fix_inr)}</b></div><div class="b"><span style="width:${o.holds_pct}%;background:${o.recommended ? "var(--ok)" : "#3C4A43"}"></span></div></div>`).join("")}</div>`).join("")}</div>`);
  $("#budget").addEventListener("change", (e) => { S.budget = Math.max(+e.target.value || 0, 0); render(); });
  $$("#rail .brow[data-ward]").forEach((el) => el.addEventListener("click", () => selectWard(el.dataset.ward)));
  $$("#rail [data-closed]").forEach((el) => el.addEventListener("click", () => {
    const [rid, typ] = el.dataset.closed.split("|");
    const x = D.closed_unfixed.find((y) => y.road_id === rid && y.issue_type === typ);
    const r = ROAD[rid];
    card(`<div class="t3 mono">${rid} · ward ${x.ward_code}</div><h2>${esc(typ)}</h2><div class="t2">${esc(r ? r.name : rid)}</div>
      <div class="mid" style="margin-top:14px">${x.complaints}<span class="u">complaints closed without a fix</span></div>
      <div class="ev" style="border-color:var(--warn)">Closed as ${Object.entries(x.statuses).map(([k, v]) => `"${esc(k)}" (${v})`).join(" and ")}. But this segment is in BMC's own road list and BMC paid ${inr(x.bmc_spend_on_road_inr)} for repairs on it this monsoon. Road matching from complaint text is about 76% exact, so confirm jurisdiction before acting.</div>
      <div class="sub t3" style="font-size:12px">First reported ${x.first} · ${x.complaint_ids.map((c) => `<span class="mono">${c}</span>`).join(" · ")}</div>`, r ? [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2] : null);
    if (r && mapReady) map.flyTo({ center: [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2], zoom: 14, offset: window.innerWidth >= 1100 ? [-180, 0] : [0, -80], duration: 900 });
  }));
  $$("#rail [data-issue]").forEach((el) => el.addEventListener("click", () => showIssue(el.dataset.issue, true)));
}

/* ---------------------------------------------------------- my complaint */
function railAsk() {
  const F = D.cleanup, ex = F.example;
  const L = { en: "English", "hi-en": "Hinglish", mr: "Marathi", hi: "Hindi" };
  rail(`<div class="card"><div class="card-h"><h3>From messy complaints to clean issues</h3><span class="badge">${F.steps[0].n.toLocaleString("en-IN")} in</span></div>
    ${ex ? `<div class="quote" style="margin-top:0">${esc(ex.description)}<div class="t3" style="font-size:12px;margin-top:4px">${ex.complaint_id} · ${esc(ex.channel)} · ${L[ex.language] || ex.language}</div></div>
    <dl class="xform"><dt>Issue</dt><dd><span class="was">${esc(ex.raw_category)}</span>${esc(ex.issue_type)} <span class="t3">from the photo</span></dd>
    <dt>Ward</dt><dd><span class="was">blank</span>${esc(ex.ward)} <span class="t3">from "${esc(ex.raw_locality)}"</span></dd>
    <dt>Status</dt><dd>${esc(ex.status)}, merged into one issue</dd>
    <dt>Fixed by</dt><dd>${D.issue_to_wo[ex.issue_id] ? `<span class="link id" data-wo="${D.issue_to_wo[ex.issue_id]}">${D.issue_to_wo[ex.issue_id]}</span>` : "not yet"}</dd></dl>` : ""}
    <details class="more"><summary>All ${F.steps.length} steps</summary><div class="funnel">${F.steps.map((f) => `<div class="f"><b>${esc(f.label)}</b><span class="n">${f.minus ? "−" : ""}${f.n.toLocaleString("en-IN")}</span><span class="d">${esc(f.note)}</span></div>`).join("")}</div></details></div>`);
  rail(`<div class="card"><h3>Trace a complaint</h3><form class="field" id="trace-f" style="margin-top:12px"><input id="trace-id" placeholder="BMC25-000006" value="${S.trace || ""}" autocomplete="off"><button class="btn light">Trace</button></form><div id="trace-out"></div></div>`);
  rail(`<div class="card"><div class="card-h"><h3>Ask Claude</h3><span class="badge">EN · हिंदी · मराठी · Hinglish</span></div>
    <div class="sub t3" style="margin-top:0;font-size:12.5px">Ask in your own language. Answers come only from the audited records and cite the work orders behind them.</div>
    <div class="chat" id="chat">${CHAT.map(msgHtml).join("")}</div>
    <div class="suggest">${["Why is Mahalaxmi Civil graded E?", "Ward L ka paisa kahan gaya?", "माझी तक्रार BMC25-000006 चे काय झाले?", "Which DLP repairs in K/W should BMC recover?"].map((s) => `<button>${esc(s)}</button>`).join("")}</div>
    <form class="field" id="ask-f" style="margin-top:10px"><input id="ask-q" placeholder="Ask about any ward, contractor or complaint" autocomplete="off"><button class="btn light">Ask</button></form></div>`);
  $("#trace-f").addEventListener("submit", (e) => { e.preventDefault(); trace($("#trace-id").value); });
  $$("#rail .suggest button").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
  $("#ask-f").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#ask-q").value.trim(); if (q) { $("#ask-q").value = ""; ask(q); } });
  if (S.trace) trace(S.trace, true);
}
function trace(raw, quiet) {
  const m = String(raw).toUpperCase().match(/BMC25-?(\d{1,6})/);
  const id = m ? `BMC25-${m[1].padStart(6, "0")}` : String(raw).trim().toUpperCase();
  const c = CP[id], out = $("#trace-out");
  if (!c) { out.innerHTML = `<div class="sub t3">No complaint ${esc(id)}. Ids look like BMC25-000123.</div>`; return; }
  const w = WO[D.issue_to_wo[c.issue_id]], p = PLAN[c.issue_id];
  const ev = [[c.received_at, `<b>Reported</b> ${esc(c.issue_type.toLowerCase())} at ${esc(c.locality_std || "?")} (ward ${c.ward_filled || "?"}) via ${esc(c.channel)}, in ${esc({ en: "English", "hi-en": "Hinglish", mr: "Marathi", hi: "Hindi" }[c.language] || c.language)}`, ""]];
  if (c.status === "Closed - Duplicate") ev.push(["", "Merged with other complaints about the same problem", ""]);
  if (w) {
    ev.push([w.assigned_at, `<b>Assigned</b> ${w.work_order_id} to ${esc(w.contractor_name)}: ${esc(w.repair_method)}, ${w.area_sqm} sqm`, ""]);
    ev.push([w.completed_at, `<b>${w.sla_met === "Y" ? "Done on time" : "Done late"}</b>: ${w.hours_taken ?? "?"} h against a ${w.sla_hours} h target. Billed ${inr(w.cost_inr, false)}, rate card ${inr(w.expected_inr, false)}`, w.sla_met === "Y" ? "good" : "bad"]);
    ev.push(["", w.reopened_within_30d === "Y" ? "<b>Failed</b>: the problem came back within 30 days" : "<b>Held</b> for at least 30 days", w.reopened_within_30d === "Y" ? "bad" : "good"]);
    topFlags(w).forEach((f) => ev.push(["", `<b>Audit flag · ${FLAG[f.code]}</b>. ${esc(f.why)}`, "bad"]));
  } else if (p) {
    ev.push(["", `<b>Not fixed yet</b> (${esc(c.status)}). Ranks #${p.ward_rank} of ${D.plan_by_ward[p.ward_code].length} open issues in ward ${p.ward_code}`, "bad"]);
    ev.push(["", `Recommended: ${esc(p.method)}${p.dlp_note ? ". " + esc(p.dlp_note) : `, about ${inr(p.est_cost_inr)}`}`, ""]);
  } else if (CLOSED.has(id)) {
    ev.push(["", `<b>Closed</b> as "${esc(c.status)}"`, "bad"]);
    ev.push(["", `But this road segment is in BMC's own road list and BMC paid contractors to repair it this monsoon. Worth asking the ward office to confirm jurisdiction.`, ""]);
  } else ev.push(["", `Status: ${esc(c.status)}`, ""]);
  out.innerHTML = `<div class="codes"><span class="code">${id}</span><span class="arr">→</span><span class="code">${w ? w.work_order_id : p ? "not fixed yet" : "no job"}</span></div>
    <div class="quote">${esc(c.description)}</div><ul class="timeline">${ev.map(([t, s, k]) => `<li class="${k}"><div class="when">${t || "&nbsp;"}</div>${s}</li>`).join("")}</ul>${w ? `<button class="btn" data-wo="${w.work_order_id}">Full evidence</button>` : ""}`;
  bindLinks(out);
  if (!quiet || S.trace !== id) {
    S.trace = id;
    mapMode();
    const loc = w ? roadMid(w.road_id) : p && p.lat != null ? [p.lon, p.lat] : c.road_guess ? roadMid(c.road_guess) : null;
    if (loc && mapReady) map.flyTo({ center: loc, zoom: 14, duration: 1000 });
  }
}
const CHAT = [];
function msgHtml(m) { return `<div class="msg ${m.role === "user" ? "me" : "bot"}">${m.role === "user" ? esc(m.content) : linkify(m.content) + (m.meta ? `<div class="tools">${m.meta}</div>` : "")}</div>`; }
async function ask(q) {
  CHAT.push({ role: "user", content: q });
  const chat = $("#chat");
  chat.insertAdjacentHTML("beforeend", msgHtml(CHAT.at(-1)) + `<div class="msg bot" id="pending">Checking the records…</div>`);
  chat.scrollTop = chat.scrollHeight;
  try {
    const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, history: CHAT.slice(0, -1).filter((m) => !m.err).map(({ role, content }) => ({ role, content })) }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "error");
    const who = (j.model || "").includes("haiku") ? "Haiku" : "Sonnet";
    CHAT.push({ role: "assistant", content: j.answer, meta: `${who}${j.escalated ? " (escalated)" : ""}${j.tools?.length ? " · " + j.tools.map((t) => esc(t.tool)).join(", ") : ""}` });
  } catch (e) {
    CHAT.push({ role: "assistant", content: `Claude is not available (${e.message}). The tracer above works without it.`, err: true });
  }
  $("#pending")?.remove();
  chat.insertAdjacentHTML("beforeend", msgHtml(CHAT.at(-1)));
  bindLinks(chat);
  chat.scrollTop = chat.scrollHeight;
  status();
}


/* ---------------------------------------------------------- story mode */
function storySteps() {
  const T = D.totals, SR = T.same_roads, top = D.same_roads[0];
  const worst = D.contractors[D.contractors.length - 1], best = D.contractors[0];
  const wl = D.plan_by_ward["L"] ? PLAN[D.plan_by_ward["L"][0]] : D.plan[0];
  const ex = D.cleanup.example;
  const wo = WO["WO25-00020"] ? "WO25-00020" : auditRows()[0]?.work_order_id;
  return [
    { tab: "trail", ward: "", title: `${inr(T.spend_inr)} on monsoon road repairs`,
      text: `MARG follows every rupee from a citizen's complaint to the job, the contractor and the bill. ${inr(T.recoverable_inr)} of it raises questions: paid while the road was under its guarantee, billed twice, or above the rate card.` },
    { tab: "trail", ward: "", title: "Spend follows the rain", play: true,
      text: "Each dot is a repair as it was finished, week by week from June. Blue bars are the rain. Orange dots carry money to question." },
    { tab: "trail", ward: "", road: top.road_id, title: "The same roads, again and again",
      text: `${SR.n} road segments were repaired ${SR.min_jobs}+ times and took ${Math.round(100 * SR.share)}% of all spend. ${top.road_name} was repaired ${top.jobs} times for ${inr(top.spend_inr)}${top.under_dlp ? ", while still under its guarantee" : ""}.` },
    { tab: "audit", ward: "L", wo, title: "Receipts, not accusations",
      text: `Every flag opens the evidence: the rate-card arithmetic, the guarantee dates, the twin bill and the complaints behind the job. We tested ${D.investigation.length} hypotheses and say which ones did not hold.` },
    { tab: "cards", ward: "", title: "Fair to contractors",
      text: `Contractors are judged against what was expected for their roads, wards, rain and targets. ${worst.name} failed ${pct(worst.reopen_pct)} of fixes against ${pct(worst.expected_reopen_pct)} expected; ${best.name} beat its expectation.` },
    { tab: "plan", ward: "L", issue: wl.issue_id, title: "Where the next rupee goes",
      text: `Never-fixed issues ranked by risk: severity, measured flood days and tides, traffic, accidents, hospitals and schools. Top in Kurla: a ${wl.issue_type.toLowerCase()} on ${wl.road_name}${wl.dlp_note ? ", which the original contractor must fix at no cost to BMC" : ""}.` },
    { tab: "ask", ward: "", trace: ex ? ex.complaint_id : "BMC25-000006", title: "A citizen asks, in their own language",
      text: "A Marathi complaint with no ward and the wrong category becomes a clean issue, linked to the job that fixed it. Claude answers questions in English, Hindi, Marathi or Hinglish, citing work order ids." },
  ];
}
let STORY = null;
function story(i) {
  const steps = storySteps();
  if (i < 0 || i >= steps.length) return endStory();
  STORY = i;
  const st = steps[i];
  stopPlay();
  closeCard();
  S.tab = st.tab; S.ward = st.ward || ""; S.budget = null; S.week = null;
  if (st.trace) S.trace = st.trace;
  $("#ward-sel").value = S.ward;
  render();
  fitScope();
  setTimeout(() => {
    if (STORY !== i) return;
    if (st.play) startPlay();
    if (st.road) showRoad(st.road, true);
    if (st.wo) showWo(st.wo);
    if (st.issue) showIssue(st.issue, true);
    if (st.trace) trace(st.trace);
  }, 900);
  $("#story")?.remove();
  $("#mapwrap").insertAdjacentHTML("beforeend", `<div class="story glass" id="story" role="dialog" aria-label="Story">
    <div class="step">${i + 1} of ${steps.length}</div><h2>${esc(st.title)}</h2><p>${esc(st.text)}</p>
    <div class="nav">${i ? '<button class="btn" id="st-prev">Back</button>' : ""}<button class="btn light" id="st-next">${i === steps.length - 1 ? "Finish" : "Next"}</button><button class="btn" id="st-end">Exit</button>
    <span class="dots">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</span></div></div>`);
  $("#st-next").onclick = () => story(i + 1);
  $("#st-end").onclick = endStory;
  $("#st-prev")?.addEventListener("click", () => story(i - 1));
}
function endStory() { STORY = null; stopPlay(); $("#story")?.remove(); }
document.addEventListener("keydown", (e) => {
  if (STORY == null || e.target.matches("input, textarea, select")) return;
  if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); story(STORY + 1); }
  if (e.key === "ArrowLeft") story(STORY - 1);
  if (e.key === "Escape") endStory();
});

/* ---------------------------------------------------------- floating cards */
function card(html, coord) {
  const f = $("#fcard");
  f.innerHTML = `<button class="x" aria-label="Close">×</button>` + html;
  f.hidden = false;
  f.scrollTop = 0;
  $(".x", f).onclick = closeCard;
  bindLinks(f);
  if (typeof countUp === "function") countUp(f);
  markSel(coord);
}
function closeCard() { $("#fcard").hidden = true; markSel(null); S.issue = null; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });

function showWo(id) {
  const w = WO[id]; if (!w) return;
  const comps = (w.linked_complaint_ids || "").split("|").filter(Boolean).map((c) => CP[c]).filter(Boolean);
  const twin = w.duplicate_of ? WO[w.duplicate_of] : null;
  const fl = topFlags(w);
  card(`<div class="t3 mono">${w.work_order_id}</div><h2>${esc(w.repair_method)}</h2><div class="t2">${esc(w.road_name)} · ward ${w.ward_code}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${fl.map((f) => `<span class="badge acc">${FLAG[f.code]}</span>`).join("") || '<span class="badge ok">No money flags</span>'}${w.reopened_within_30d === "Y" ? '<span class="badge">Failed in 30 days</span>' : ""}${w.sla_met === "N" ? '<span class="badge">Missed SLA</span>' : ""}${w.flags.some((f) => f.code === "OUTSIDE_PANEL") ? '<span class="badge" title="No contractor is empanelled in this ward">Outside panel</span>' : ""}${w.flags.some((f) => f.code === "DLP_RECORDS_GAP") ? '<span class="badge warnb" title="Verify against the contract">Verify: DLP records</span>' : ""}${CHRONIC[w.road_id] ? `<span class="badge link" data-road="${w.road_id}">Road repaired ${CHRONIC[w.road_id].jobs}x</span>` : ""}</div>
    ${w.recoverable_inr ? `<div class="mid" style="margin-top:14px">${bigInr(w.recoverable_inr)}<span class="u">to question</span></div>` : ""}
    <dl class="dl"><dt>Contractor</dt><dd>${esc(w.contractor_name)}</dd><dt>Billed</dt><dd>${inr(w.cost_inr, false)} <span class="t3">vs rate card ${inr(w.expected_inr, false)} (${w.cost_ratio.toFixed(2)}x)</span></dd><dt>Job</dt><dd>${esc(w.work_type)}, ${w.area_sqm} sqm</dd>
    <dt>Timeline</dt><dd>${w.assigned_at} → ${w.completed_at}</dd><dt>Target</dt><dd>${w.hours_taken != null ? `${w.hours_taken} h of ${w.sla_hours} h` : `${w.sla_hours} h`}: ${w.sla_met === "Y" ? '<span class="okc">met</span>' : '<span class="acc">missed</span>'}</dd>
    <dt>Held up?</dt><dd>${w.reopened_within_30d === "Y" ? '<span class="acc">No</span>' : '<span class="okc">Yes</span>'} <span class="t3">· ${pct(100 * w.p_reopen)} expected failure, ${w.rain_30d} mm rain after</span></dd><dt>Remark</dt><dd>${esc(w.engineer_remark || "none")}</dd></dl>
    ${typeof REPLIES !== "undefined" && REPLIES[w.work_order_id] ? `<div class="ev" style="border-color:var(--ok)"><b>Contractor's reply</b> (${esc(REPLIES[w.work_order_id].at)}). ${esc(REPLIES[w.work_order_id].text)}</div>` : ""}
    ${fl.map((f) => `<div class="ev"><b>${FLAG[f.code]}.</b> ${esc(f.why)}</div>`).join("")}
    ${w.flags.filter((f) => f.code === "OUTSIDE_PANEL").map((f) => `<div class="ev" style="border-color:var(--t3)"><b>Outside panel.</b> ${esc(f.why)}</div>`).join("")}
    ${w.flags.filter((f) => f.code === "DLP_RECORDS_GAP").map((f) => `<div class="ev" style="border-color:var(--warn)"><b>Verify: DLP records gap.</b> ${esc(f.why)}</div>`).join("")}
    ${twin ? `<div class="ev"><b>The twin:</b> <span class="link id" data-wo="${twin.work_order_id}">${twin.work_order_id}</span>, ${twin.assigned_at}, ${twin.area_sqm} sqm, ${inr(twin.cost_inr, false)}, complaints ${esc(twin.linked_complaint_ids)}</div>` : ""}
    <h3 style="margin-top:16px">Complaints behind this job · ${comps.length}</h3>
    ${comps.length ? comps.map((c) => `<div class="quote"><span class="mono t3">${c.complaint_id} · ${c.received_at} · ${esc(c.channel)}</span><br>${esc(c.description)}</div>`).join("") : '<div class="sub t3">None. No citizen complaint was linked to this job.</div>'}`, roadMid(w.road_id) && jitter(w.work_order_id, roadMid(w.road_id)));
  if (mapReady && window.innerWidth >= 1100) { const c = roadMid(w.road_id); if (c) map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 13.2), offset: [-180, 0], duration: 700 }); }
}
function showIssue(id, fly) {
  const p = PLAN[id]; if (!p) return;
  S.issue = id;
  const loc = p.lat != null ? [p.lon, p.lat] : p.road_id ? roadMid(p.road_id) : null;
  card(`<div class="t3 mono">${p.issue_id} · ward ${p.ward_code} · rank ${p.ward_rank} in ward</div><h2>${esc(p.issue_type)}</h2><div class="t2">${esc(p.road_name || "")}${p.road_name && p.locality ? " · " : ""}${esc(p.locality || "")}</div>
    <div class="mid" style="margin-top:14px">${Math.round(p.risk)}<span class="u">/ 100 risk</span></div>
    <div class="riskbar" style="height:6px">${Object.entries(p.risk_parts).map(([k, v]) => `<span style="width:${v}%;background:${PART[k][0]}" title="${k} ${v}"></span>`).join("")}</div>
    <div class="ev" style="border-color:var(--water)">${p.reasons.map(esc).join("<br>")}</div>
    <dl class="dl"><dt>Fix with</dt><dd>${esc(p.method)}${p.holds_pct ? ` <span class="t3">· holds ${pct(p.holds_pct)}${p.surface ? ` on ${esc(p.surface.toLowerCase())} roads` : ""}</span>` : ""}</dd><dt>Cost to BMC</dt><dd>${p.dlp_note ? '<span class="okc">₹0</span>' : inr(p.est_cost_inr)}</dd><dt>First reported</dt><dd>${p.first_reported}</dd><dt>Complaints</dt><dd>${p.complaints} · ${p.upvotes} me-too · ${p.languages.join(", ")}</dd></dl>
    ${p.dlp_note ? `<div class="ev" style="border-color:var(--ok)">${esc(p.dlp_note)}</div>` : ""}
    ${p.road_id && CHRONIC[p.road_id] ? `<div class="ev"><b>Same road again.</b> This segment was already repaired ${CHRONIC[p.road_id].jobs} times this monsoon for ${inr(CHRONIC[p.road_id].spend_inr)}. <span class="link" data-road="${p.road_id}">See every repair</span></div>` : ""}
    <div class="quote">${esc(p.sample)}</div>
    <div class="sub t3" style="font-size:12px">${p.complaint_ids.map((c) => `<span class="mono">${c}</span>`).join(" · ")}</div>
    ${p.social?.length ? `<h3 style="margin-top:16px">Also on social media · ${p.social_count}</h3>${p.social.map((x) => `<div class="soc">${esc(x.text)}<div class="t3">${esc(x.source)} · ${x.posted_at} · ${esc(x.kind)} · ${x.likes} likes or forwards</div></div>`).join("")}<div class="sub t3" style="font-size:11.5px">Posts in the same ward, about the same road or locality and issue type. Supporting context, not proof.</div>` : ""}`, loc && jitter(p.issue_id, loc, 0.0005));
  if (fly && loc && mapReady) map.flyTo({ center: loc, zoom: 14, offset: window.innerWidth >= 1100 ? [-180, 0] : [0, -80], duration: 900 });
  $$("#rail [data-issue]").forEach((el) => el.classList.toggle("on", el.dataset.issue === id));
}
function showHotspot(h) {
  card(`<div class="t3 mono">${h.id} · ward ${h.ward}</div><h2>${esc(h.name)}</h2><div class="t2">Chronic flood spot</div>
    <div class="mid" style="margin-top:14px">${h.wet_days}<span class="u">days flooded in 2025</span></div>
    <dl class="dl"><dt>Floods at</dt><dd>${h.threshold} mm of rain a day</dd><dt>Tide-sensitive</dt><dd>${h.tide === true || h.tide === "true" ? `yes · ${h.tide_days} flood days had a big tide` : "no"}</dd><dt>Water depth</dt><dd>${h.depth} cm on average</dd><dt>Flagged</dt><dd>${h.years} of the last 5 years</dd></dl>`, [h.lon, h.lat]);
}

function showRoad(id, fly) {
  const s = CHRONIC[id], r = ROAD[id];
  if (!s || !r) return;
  const jobs = s.work_orders.map((i) => WO[i]).filter(Boolean);
  const byM = {};
  jobs.forEach((w) => (byM[w.repair_method] = (byM[w.repair_method] || 0) + 1));
  card(`<div class="t3 mono">${id} · ward ${s.ward_code} · ${esc(s.road_type)} · ${esc(s.surface)}</div><h2>${esc(s.road_name)}</h2><div class="t2">${s.length_m} m segment, last resurfaced ${s.last_resurfaced}</div>
    <div class="mid" style="margin-top:14px">${s.jobs}<span class="u">repairs in one monsoon</span></div>
    <div class="kv"><div><div class="k">Spent</div><div class="v">${inr(s.spend_inr)}</div></div><div><div class="k">Failed in 30 days</div><div class="v">${s.failed}</div></div><div><div class="k">Per week</div><div class="v">${s.per_week}</div></div></div>
    ${typeof roadStrip === "function" ? roadStrip(jobs) : ""}
    ${s.under_dlp ? `<div class="ev"><b>Still under DLP.</b> Every repair here should have been the original contractor's job at no cost to BMC, yet BMC paid ${inr(s.spend_inr)}.</div>` : ""}
    <div class="ev" style="border-color:var(--water)"><b>What this says.</b> ${s.jobs} separate repairs on one ${s.length_m} m stretch means patching is not holding the road. ${s.resurface_remark ? `Engineers wrote "needs resurfacing after monsoon" on ${s.resurface_remark} of these jobs. ` : ""}This segment needs a structural inspection after the monsoon rather than repair number ${s.jobs + 1}.</div>
    <dl class="dl"><dt>By contractor</dt><dd>${s.contractors.map((c) => `${esc(c.name)} ${c.jobs}`).join(" · ")}</dd><dt>By method</dt><dd>${Object.entries(byM).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${esc(m)} ${n}`).join(" · ")}</dd></dl>
    <h3 style="margin-top:16px">Every repair</h3>
    <table class="tbl" style="margin-top:6px"><tbody>${jobs.map((w) => `<tr class="click" data-wo="${w.work_order_id}"><td class="id">${w.work_order_id}</td><td class="t3">${w.completed_at.slice(5, 10)}</td><td>${esc(w.work_type)}</td><td class="num">${inr(w.cost_inr)}</td><td>${w.reopened_within_30d === "Y" ? '<span class="off">failed</span>' : '<span class="off ok">held</span>'}</td></tr>`).join("")}</tbody></table>`,
    [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2]);
  if (fly && mapReady) map.fitBounds([[Math.min(r.a[0], r.b[0]), Math.min(r.a[1], r.b[1])], [Math.max(r.a[0], r.b[0]), Math.max(r.a[1], r.b[1])]], { padding: window.innerWidth >= 1100 ? { top: 160, bottom: 220, left: 120, right: 500 } : 60, maxZoom: 15, duration: 900 });
}

/* ---------------------------------------------------------- claude text */
async function narrate(kind, key, el, btn, cachedOnly, refresh, onDone) {
  if (!cachedOnly) { btn.disabled = true; el.textContent = "Claude is writing from the audited records…"; }
  try {
    const j = await fetch(`/api/narrate/${kind}/${encodeURIComponent(key)}?${cachedOnly ? "cached_only=true" : refresh ? "refresh=true" : ""}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.detail); return j; });
    if (j.text) { el.innerHTML = linkify(j.text); bindLinks(el); if (btn) btn.textContent = kind === "ward" ? "Rewrite" : btn.textContent; onDone?.(); }
    else if (cachedOnly && kind === "ward") el.innerHTML = `<span class="t3">Not written yet. Press Write for a plain-language summary from Claude.</span>`;
  } catch (e) { el.innerHTML = `<span class="t3">Claude is not available (${esc(e.message)}).</span>`; }
  if (btn) btn.disabled = false;
  status();
}
function linkify(t) {
  return esc(String(t).replace(/Rs\.? ?(?=\d)/g, "₹")).replace(/^#+\s*(.+)$/gm, "<b>$1</b>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/\b(WO25-\d{5})\b/g, '<span class="link id" data-wo="$1">$1</span>').replace(/\b(OPEN-\d{4})\b/g, '<span class="link id" data-issue="$1">$1</span>');
}
function bindLinks(root) {
  $$("[data-wo]", root).forEach((el) => { if (el.dataset.b) return; el.dataset.b = 1; el.addEventListener("click", (e) => { e.stopPropagation(); showWo(el.dataset.wo); }); });
  $$(".link[data-issue], .narr [data-issue], .msg [data-issue]", root).forEach((el) => { if (el.dataset.b) return; el.dataset.b = 1; el.addEventListener("click", () => showIssue(el.dataset.issue, true)); });
  $$(".link[data-road]", root).forEach((el) => { if (el.dataset.b) return; el.dataset.b = 1; el.addEventListener("click", (e) => { e.stopPropagation(); if (S.tab !== "trail") go("trail"); showRoad(el.dataset.road, true); }); });
}
function find(q) {
  q = q.trim().toUpperCase();
  if (/^WO25-?\d+/.test(q)) { const id = "WO25-" + q.replace(/\D/g, "").slice(-5).padStart(5, "0"); if (WO[id]) return showWo(id); }
  if (/^OPEN-?\d+/.test(q)) return showIssue("OPEN-" + q.replace(/\D/g, "").padStart(4, "0"), true);
  if (/BMC|^\d+$/.test(q)) { S.trace = q; go("ask"); return; }
}
function rail(html) { $("#rail").insertAdjacentHTML("beforeend", html); }
window.addEventListener("resize", () => mapReady && map.resize());

boot();
