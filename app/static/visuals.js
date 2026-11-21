/* Visual cues that carry meaning: money columns, repair ripples, flood swell,
   count-up numbers and road histories. All respect prefers-reduced-motion. */
const CALM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------- 3D money columns */
function circlePoly([lon, lat], meters, n = 28) {
  const dLat = meters / 111320, dLon = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return ring;
}
function initVisuals() {
  if (!mapReady) return;
  const mx = Math.max(...D.wards.map((w) => w.recoverable_inr));
  map.addSource("cols", { type: "geojson", data: { type: "FeatureCollection", features: D.wards.map((w) => ({
    type: "Feature", properties: { ward_code: w.ward_code, h: Math.round((w.recoverable_inr / mx) * 2600), v: w.recoverable_inr },
    geometry: { type: "Polygon", coordinates: [circlePoly(w.centroid, 380)] } })) } });
  map.addLayer({ id: "cols", type: "fill-extrusion", source: "cols", paint: {
    "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#5A3A22", 1600, "#C25E16", 3200, "#FF7A1A"],
    "fill-extrusion-height": 0, "fill-extrusion-base": 0,
    "fill-extrusion-opacity": 0.88, "fill-extrusion-height-transition": { duration: 1200, delay: 0 } } });
  map.setLayoutProperty("cols", "visibility", "none");
  map.addSource("col-tops", { type: "geojson", data: { type: "FeatureCollection", features: D.wards.map((w) => ({ type: "Feature", properties: { label: inr(w.recoverable_inr), ward_code: w.ward_code }, geometry: { type: "Point", coordinates: w.centroid } })) } });
  // ripples: a ring that expands from each repair finished this week
  map.addLayer({ id: "ripple", type: "circle", source: "jobs", filter: ["==", ["get", "pulse"], true], paint: {
    "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["case", ["get", "flag"], "#FF7A1A", "#EEF2EE"], "circle-stroke-width": 1.5,
    "circle-radius": 2, "circle-stroke-opacity": 0 } });
  // flood spots swell in weeks when rain crossed their threshold
  const swell = ["case", ["boolean", ["get", "now"], false], 1.6, 1];
  map.setPaintProperty("hot-glow", "circle-radius", ["interpolate", ["linear"], ["zoom"],
    10, ["*", swell, ["+", 6, ["*", ["get", "wet_days"], 0.9]]],
    15, ["*", swell, ["+", 30, ["*", ["get", "wet_days"], 3]]]]);
  map.setPaintProperty("hot-glow", "circle-radius-transition", { duration: 600 });
  map.on("click", "cols", (e) => { if (S.tab === "trail" && !S.ward) selectWard(e.features[0].properties.ward_code); });
  map.on("mouseenter", "cols", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "cols", () => (map.getCanvas().style.cursor = ""));
  visualMode();
}
function visualMode() {
  if (!mapReady || !map.getLayer("cols")) return;
  const city = S.tab === "trail" && !S.ward;
  map.setLayoutProperty("cols", "visibility", city ? "visible" : "none");
  // columns rise when you arrive at the city view
  map.setPaintProperty("cols", "fill-extrusion-height", 0);
  if (city) setTimeout(() => map.getLayer("cols") && map.setPaintProperty("cols", "fill-extrusion-height", ["get", "h"]), CALM ? 0 : 250);
  floodNow();
}
function cameraFor() {
  const city = S.tab === "trail" && !S.ward && window.innerWidth >= 1100;
  return { pitch: city ? 48 : 0, bearing: city ? -14 : 0 };
}

/* ---------------------------------------------------- ripples and flood swell */
let rippleRAF = null;
function ripple() {
  if (!mapReady || !map.getLayer("ripple") || CALM) return;
  cancelAnimationFrame(rippleRAF);
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min((t - t0) / dur, 1);
    map.setPaintProperty("ripple", "circle-radius", 3 + k * 22);
    map.setPaintProperty("ripple", "circle-stroke-opacity", 0.9 * (1 - k));
    if (k < 1) rippleRAF = requestAnimationFrame(step);
  };
  rippleRAF = requestAnimationFrame(step);
}
function floodNow() {
  if (!mapReady) return;
  const wk = S.tab === "trail" && typeof S.week === "number" ? S.week : null;
  const byDay = {};
  D.map.rain.forEach((r) => (byDay[r.date] = r));
  const feats = D.map.hotspots.map((h) => {
    let now = false;
    if (wk != null) {
      const st = isIsland(h.ward) ? "Colaba" : "Santacruz";
      now = D.map.rain.some((r) => weekKey(r.date) === wk && r[st] >= h.threshold);
    }
    return { type: "Feature", properties: { ...h, now }, geometry: { type: "Point", coordinates: [h.lon, h.lat] } };
  });
  map.getSource("hot").setData({ type: "FeatureCollection", features: feats });
}

/* ---------------------------------------------------- count-up numbers */
function countUp(root) {
  if (CALM || !root) return;
  root.querySelectorAll(".big, .mid").forEach((el) => {
    if (el.dataset.counted) return;
    el.dataset.counted = 1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) { if (/\d/.test(node.nodeValue)) break; }
    if (!node) return;
    const m = node.nodeValue.match(/[\d,]+(\.\d+)?/);
    if (!m) return;
    const raw = m[0], target = parseFloat(raw.replace(/,/g, "")), dec = m[1] ? m[1].length - 1 : 0, grouped = raw.includes(",");
    if (!isFinite(target) || target === 0) return;
    const pre = node.nodeValue.slice(0, m.index), post = node.nodeValue.slice(m.index + raw.length);
    const fmt = (v) => (grouped ? v.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec));
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - k, 3);
      node.nodeValue = pre + fmt(target * e) + post;
      if (k < 1) requestAnimationFrame(step); else node.nodeValue = pre + raw + post;
    };
    requestAnimationFrame(step);
  });
}

/* ---------------------------------------------------- road repair history */
function roadStrip(jobs) {
  const start = new Date(2025, 5, 1).getTime(), end = new Date(2025, 9, 11).getTime(), W = 340;
  const x = (d) => ((new Date(d.replace(" ", "T")).getTime() - start) / (end - start)) * W;
  const ticks = jobs.map((w) => `<line x1="${x(w.completed_at).toFixed(1)}" x2="${x(w.completed_at).toFixed(1)}" y1="${w.reopened_within_30d === "Y" ? 6 : 14}" y2="34" stroke="${w.recoverable_inr > 0 ? "#FF7A1A" : w.reopened_within_30d === "Y" ? "#F6EFDD" : "#7E8A83"}" stroke-width="2" stroke-linecap="round"/>`).join("");
  const months = ["Jun", "Jul", "Aug", "Sep", "Oct"].map((m, i) => `<text x="${x(`2025-${String(6 + i).padStart(2, "0")}-01 00:00`) + 2}" y="48" fill="#8C968F" font-size="10">${m}</text>`).join("");
  return `<div class="strip"><svg viewBox="0 0 ${W} 52" preserveAspectRatio="none">${ticks}${months}</svg>
    <div class="t3" style="font-size:12px">Each line is a repair. Tall: failed within 30 days. Orange: money to question.</div></div>`;
}
