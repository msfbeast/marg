// MARG demo capture: drives the live site through the 8 script beats and records
// every frame with a CDP screencast. Output: frames_cap/*.jpg + frames_cap/index.json
// Usage: node capture.js [url] [--warm-only]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "https://marg-mumbai.vercel.app/#trail";
const OUT = path.join(__dirname, "frames_cap");
const W = 1920, H = 1080;

// beat lengths in seconds, timed to Sajid's recorded VO ("Voice Over Sajid.m4a", 2:05)
const BEATS = [
  ["hook", 13.6], ["anecdote", 13.5], ["intro", 10.4], ["money", 23.5],
  ["fairness", 25.4], ["nextrupee", 16.0], ["action", 11.9], ["close", 13.7],
];

const CSS = `
#story { display: none !important; }
#vo { position: absolute; inset: 0; z-index: 50; pointer-events: none; font-family: "Inter Tight", system-ui, sans-serif; color: var(--text); }
#vo .scrim { position: fixed; z-index: 60; inset: 0; background: rgba(6, 16, 22, 0.9); opacity: 0; transition: opacity 0.9s ease; }
#vo .scrim.on { opacity: 1; }
#vo .center { position: fixed; z-index: 61; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; opacity: 0; transition: opacity 0.8s ease, transform 0.8s ease; }
#vo .center.on { opacity: 1; }
#vo .center > div { display: block; width: auto; height: auto; }
#vo .huge { font-size: 300px; font-weight: 300; letter-spacing: -0.06em; line-height: 0.9; color: var(--hot); font-variant-numeric: tabular-nums; }
#vo .l1 { font-size: 40px; font-weight: 400; letter-spacing: -0.02em; margin-top: 18px; color: var(--text); }
#vo .l2 { font-size: 34px; font-weight: 400; letter-spacing: -0.02em; margin-top: 22px; opacity: 0; transition: opacity 0.8s ease; }
#vo .l2.on { opacity: 1; }
#vo .vmark { font-size: 170px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: var(--hot); }
#vo .exp { font-size: 38px; font-weight: 400; letter-spacing: -0.01em; margin-top: 14px; color: var(--text); }
#vo .exp b { color: var(--accent); font-weight: 600; }
#vo .dev { font-size: 30px; margin-top: 18px; color: var(--t2); }
#vo .url { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 30px; margin-top: 30px; color: var(--accent); }
#vo .small { font-size: 22px; margin-top: 16px; color: var(--t3); }
#vo .quote { position: absolute; left: 50%; top: 50%; width: 900px; transform: translate(-50%, -40%); padding: 34px 40px; opacity: 0; transition: opacity 0.8s ease, transform 0.8s ease; }
#vo .quote.on { opacity: 1; transform: translate(-50%, -50%); }
#vo .quote .q { font-size: 40px; font-weight: 400; letter-spacing: -0.02em; line-height: 1.25; }
#vo .quote .src { font-size: 18px; color: var(--t3); margin-top: 18px; }
#vo .cap { position: absolute; left: 22px; bottom: 22px; width: 520px; padding: 18px 22px; opacity: 0; transform: translateY(10px); transition: opacity 0.6s ease, transform 0.6s ease; }
#vo .cap.on { opacity: 1; transform: none; }
#vo .cap h2 { margin: 0 0 6px; font-size: 26px; font-weight: 400; letter-spacing: -0.02em; line-height: 1.15; }
#vo .cap p { margin: 0; color: var(--t2); font-size: 15.5px; line-height: 1.45; }
.ct.vfocus { outline: 2px solid var(--accent); outline-offset: 2px; }
.ct.vfocus-ok { outline: 2px solid var(--ok); outline-offset: 2px; }
.ov-grid.vdim .ct:not(.vfocus):not(.vfocus-ok) { opacity: 0.35; transition: opacity 0.6s ease; }
`;

// runs in the page: helpers for the overlay layer
const PAGE_HELPERS = () => {
  const root = document.createElement("div");
  root.id = "vo";
  document.getElementById("mapwrap").appendChild(root);
  window.V = {
    clear() { root.innerHTML = ""; },
    html(h) { root.insertAdjacentHTML("beforeend", h); return root.lastElementChild; },
    on(sel) { document.querySelectorAll("#vo " + sel).forEach((e) => e.classList.add("on")); },
    off(sel) { document.querySelectorAll("#vo " + sel).forEach((e) => e.classList.remove("on")); },
    cap(title, text) {
      root.querySelectorAll(".cap").forEach((e) => { e.classList.remove("on"); setTimeout(() => e.remove(), 700); });
      const el = V.html(`<div class="cap glass"><h2>${title}</h2><p>${text}</p></div>`);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
    },
    count(el, to, ms) {
      const t0 = performance.now();
      const f = (t) => { const k = Math.min((t - t0) / ms, 1); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    },
    nocols() { const f = () => map.getLayer("cols") && map.setLayoutProperty("cols", "visibility", "none"); f(); setTimeout(f, 300); setTimeout(f, 1100); },
    city(drift) {
      closeCard(); S.tab = "trail"; S.ward = ""; S.week = null; render(); fitScope();
      if (drift) setTimeout(() => map.easeTo({ bearing: map.getBearing() - drift, duration: 18000, easing: (k) => k }), 1400);
    },
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof mapReady !== "undefined" && mapReady, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: CSS });
  await page.evaluate(PAGE_HELPERS);
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // warm pass: visit every place once so tiles and data are cached before recording
  for (const fn of [() => showRoad("RD0220", true), () => story(3), () => story(5), () => story(6), () => { endStory(); V.city(0); }]) {
    await ev(fn); await sleep(3500);
  }
  await ev(() => { endStory(); applyRole && applyRole(""); V.clear(); V.city(0); });
  await sleep(4000);
  if (process.argv.includes("--warm-only")) { await browser.close(); return; }

  // recorder
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let t0 = null, n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const ts = f.metadata.timestamp;
    if (t0 == null) { t0 = ts; console.log("first frame ts", ts, "wall", Date.now() / 1000); }
    const file = `f${String(n++).padStart(6, "0")}.jpg`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(f.data, "base64"));
    frames.push({ t: ts - wall0 / 1000, file });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const marks = [];
  const wall0 = Date.now();
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(300);
  const at = async (sec) => { const wait = wall0 + sec * 1000 - Date.now(); if (wait > 0) await sleep(wait); };
  let T = 0.5; // beat clock (s), small lead-in
  const beat = (name, len) => { marks.push({ name, start: T, len }); const s = T; T += len; return s; };

  // 1. hook: "35"
  let s = beat(...BEATS[0]);
  await at(s);
  await ev(() => {
    V.clear();
    showRoad("RD0220", true);
    V.nocols();
    V.html('<div class="scrim on"></div>');
    const c = V.html('<div class="center"><div class="huge" id="v35">0</div><div class="l1">repairs on one 506 m stretch of Kurla Andheri Road, in one monsoon</div><div class="l2" id="vl2"><span class="acc">₹30.5 L</span> paid, while the road was still under guarantee</div></div>');
    requestAnimationFrame(() => c.classList.add("on"));
    V.count(document.getElementById("v35"), 35, 1600);
  });
  await at(s + 8.0); await ev(() => V.on("#vl2"));
  await at(s + 12.3); await ev(() => { V.off(".scrim"); V.off(".center"); });
  s = beat(...BEATS[1]);
  await at(s); await ev(() => V.cap("Kurla Andheri Road · RD0220", "35 repairs, 6 failed within 30 days, ₹30.5 L. Under its Defect Liability Period, so every repair was the original contractor's to make at no cost to BMC."));

  // 2. anecdote: the post
  await at(s + 5.5); await ev(() => { V.clear(); V.city(8); });
  await at(s + 7.2); await ev(() => {
    const q = V.html('<div class="quote glass"><div class="q">“Just fixed last week and pothole is BACK on Kurla Andheri Road. Who checks quality @mybmc?”</div><div class="src">SOC00603 · WhatsApp group · 6 Jul 2025 · from the challenge dataset</div></div>');
    requestAnimationFrame(() => requestAnimationFrame(() => q.classList.add("on")));
  });

  // 3. intro: MARG
  s = beat(...BEATS[2]);
  await at(s); await ev(() => {
    V.off(".quote");
    V.html('<div class="scrim"></div>');
    const c = V.html('<div class="center"><div class="vmark">MARG</div><div class="exp"><b>M</b>onsoon <b>A</b>udit of <b>R</b>oad <b>G</b>uarantees</div><div class="dev">मार्ग · road</div><div class="small">Every rupee, from a citizen\'s complaint to the contractor\'s final bill</div></div>');
    requestAnimationFrame(() => requestAnimationFrame(() => { V.on(".scrim"); c.classList.add("on"); }));
  });
  await at(s + 9.7); await ev(() => { V.off(".scrim"); V.off(".center"); });

  // 4. money: totals, rain timeline, same roads
  s = beat(...BEATS[3]);
  await at(s); await ev(() => { V.clear(); story(0); const t = storySteps()[0]; V.cap(t.title, `${inr(D.totals.recoverable_inr)} to question: paid while the road was under guarantee, billed twice, or above the rate card.`); });
  await at(s + 9); await ev(() => { story(1); setTimeout(() => { stopPlay(); S.week = WEEKS[0]; timeline(); jobsLayer(); const iv = setInterval(() => { const i = WEEKS.indexOf(S.week); if (i >= WEEKS.length - 1) { clearInterval(iv); S.week = null; timeline(); jobsLayer(); return; } S.week = WEEKS[i + 1]; timeline(); jobsLayer(); }, 480); }, 950); V.cap("Spend follows the rain", "Each dot is a repair, week by week from June. Blue bars are rain. Orange dots carry money to question."); });
  await at(s + 18.2); await ev(() => { const t = storySteps()[2]; story(2); V.nocols(); V.cap(t.title, t.text); });

  // 5. fairness: receipts, then scorecards
  s = beat(...BEATS[4]);
  await at(s); await ev(() => { V.clear(); story(3); V.cap("Receipts, not accusations", "Every flag opens its evidence: the rate-card arithmetic, the guarantee dates, the twin bill and the complaints behind the job."); });
  await at(s + 3); await ev(() => { const f = document.getElementById("fcard"); f.scrollTo({ top: 260, behavior: "smooth" }); });
  await at(s + 7); await ev(() => {
    endStory(); closeCard(); go("cards");
    V.cap("Fair to contractors", "Ring: what was expected for their roads, wards, rain and targets. Dot: what happened.");
  });
  await at(s + 12.7); await ev(() => {
    document.querySelector(".ov-grid").classList.add("vdim");
    document.getElementById("ct-CT05").classList.add("vfocus-ok");
    V.cap("Deccan Paving beat its expectation", "9% of fixes failed against 24% expected for its roads and rain.");
  });
  await at(s + 14.9); await ev(() => {
    document.getElementById("ct-CT03").classList.add("vfocus");
    document.getElementById("ct-CT03").scrollIntoView({ behavior: "smooth", block: "center" });
    V.cap("Mahalaxmi Civil: questions to answer", "38% of fixes failed against 25% expected. Every flag is a question, and contractors can reply on the record.");
  });
  await at(s + 20.8); await ev(() => { S.contractor = "CT03"; applyRole("contractor"); setTimeout(() => { document.querySelector(".ov-grid")?.classList.add("vdim"); document.getElementById("ct-CT03")?.classList.add("vfocus"); }, 300); });

  // 6. next rupee
  s = beat(...BEATS[5]);
  await at(s); await ev(() => { V.clear(); applyRole(""); const t = storySteps()[5]; story(5); V.cap(t.title, "Never-fixed issues ranked by risk: flooding, traffic, accidents, hospitals and schools nearby."); });
  await at(s + 9.2); await ev(() => V.cap("Top in Kurla: a road cave-in", "The road is under its guarantee, so the original contractor fixes it. Cost to BMC: ₹0."));

  // 7. action: Marathi complaint, ward officer notice
  s = beat(...BEATS[6]);
  await at(s); await ev(() => { V.clear(); story(6); V.cap("A complaint in Marathi", "No ward and the wrong category on filing. MARG cleans it and links it to the job that fixed it."); });
  await at(s + 6.9); await ev(() => { endStory(); applyRole("officer"); V.cap("View as ward officer", "Claude drafts the recovery notice from the audited record. The officer checks it before sending."); });
  await at(s + 8.5); await ev(() => { document.getElementById("draft")?.scrollIntoView({ behavior: "smooth", block: "start" }); });

  // 8. close
  s = beat(...BEATS[7]);
  await at(s); await ev(() => { V.clear(); applyRole(""); V.city(8); });
  await at(s + 4.5); await ev(() => {
    V.html('<div class="scrim"></div>');
    const c = V.html('<div class="center"><div class="vmark">MARG</div><div class="exp"><b>M</b>onsoon <b>A</b>udit of <b>R</b>oad <b>G</b>uarantees</div><div class="url">marg-mumbai.vercel.app</div><div class="small">Built with Claude · Sonnet 5.5 for judgement, Haiku 5.5 for lookups · Claude Impact Lab Mumbai</div></div>');
    requestAnimationFrame(() => requestAnimationFrame(() => { V.on(".scrim"); c.classList.add("on"); }));
  });
  await at(T + 0.3);
  await cdp.send("Page.stopScreencast");
  await sleep(500);
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ frames, marks, total: T }, null, 1));
  console.log(`frames ${frames.length}, ${(frames.length / T).toFixed(1)} fps avg, total ${T.toFixed(1)} s`);
  await browser.close();
})();
