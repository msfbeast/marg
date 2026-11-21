/* Roles: the same evidence, arranged for the person who has to act on it.
   No real sign-in in this demo: in production each role would use BMC's own login. */
let REPLIES = {};
const ROLE_LABEL = { citizen: "Citizen", officer: "Ward officer", corporator: "Corporator", contractor: "Contractor" };
const LANGS = [["en", "English"], ["hi", "हिंदी"], ["mr", "मराठी"]];

async function initRoles() {
  try { REPLIES = await fetch("/api/replies").then((r) => r.json()); } catch (e) { REPLIES = {}; }
  S.role = S.role || "";
  S.lang = S.lang || "mr";
  $("#role-sel").addEventListener("change", (e) => applyRole(e.target.value));
}

function applyRole(role) {
  if (typeof endStory === "function") endStory();
  S.role = role;
  $("#role-sel").value = role;
  closeCard();
  if (role === "citizen") { S.tab = "ask"; S.ward = ""; if (!S.trace) S.trace = (D.cleanup.example || {}).complaint_id || "BMC25-000006"; }
  if (role === "officer") { S.tab = "audit"; S.ward = S.ward || "L"; S.flag = "ALL"; }
  if (role === "corporator") { S.tab = "trail"; S.ward = S.ward || "L"; }
  if (role === "contractor") { S.tab = "cards"; S.contractor = S.contractor || D.contractors[D.contractors.length - 1].contractor_id; }
  $("#ward-sel").value = S.ward;
  render();
  fitScope();
  if (role === "contractor") setTimeout(() => document.getElementById("ct-" + S.contractor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
}

function roleCard() {
  const r = S.role;
  if (!r) return;
  const head = `<div class="card-h"><h3><span class="rolepill">${ROLE_LABEL[r]}</span> What you can do</h3><button class="arrow" id="role-x" title="Back to everyone's view">×</button></div>`;
  const note = `<div class="sub t3" style="font-size:12px">Demo view. In production each role signs in with BMC's own login.</div>`;
  let body = "";
  if (r === "citizen") {
    const c = S.trace && CP[S.trace];
    body = `<div class="sub" style="margin-top:0">${c ? `Your complaint <b>${c.complaint_id}</b>. Claude drafts a polite escalation to your ward office from the record, in your language.` : "Trace your complaint below first."}</div>
      ${c ? `<div class="chips" style="margin-top:10px">${LANGS.map(([k, l]) => `<button class="chip ${S.lang === k ? "on" : ""}" data-lang="${k}">${l}</button>`).join("")}</div>
      <div class="actions"><button class="btn light" data-draft="citizen_letter">Draft my letter</button></div>` : ""}`;
  } else if (r === "officer") {
    if (!S.ward) body = `<div class="sub">Pick your ward from the ward menu.</div>`;
    else {
      const w = WARD[S.ward];
      const dlp = D.work_orders.filter((x) => x.ward_code === S.ward && x.under_dlp === "Y");
      body = `<div class="sub" style="margin-top:0">Ward <b>${esc(S.ward)}</b> · ${esc(w.office)}</div>
        <div class="acts">
          <div class="act"><div><b>Recover DLP money</b><div class="t3">${dlp.length} paid jobs on guaranteed roads · ${inr(dlp.reduce((a, x) => a + x.cost_inr, 0))}</div></div><button class="btn light" data-draft="dlp_notice">Draft notice</button></div>
          <div class="act"><div><b>Verify jurisdiction</b><div class="t3">${w.closed_unfixed} complaints closed as another agency's road</div></div><button class="btn" id="csv-juris">Checklist CSV</button></div>
          <div class="act"><div><b>Next week's work packet</b><div class="t3">Never-fixed issues that fit the budget, with method and cost</div></div><button class="btn" id="csv-packet">Work packet CSV</button></div>
        </div>`;
    }
  } else if (r === "corporator") {
    body = S.ward ? `<div class="sub" style="margin-top:0">Ward <b>${esc(S.ward)}</b>. Five fair, evidence-backed questions for the ward committee meeting.</div><div class="actions"><button class="btn light" data-draft="committee_questions">Draft my questions</button></div>`
      : `<div class="sub">Pick your ward from the ward menu.</div>`;
  } else if (r === "contractor") {
    const c = D.contractors.find((x) => x.contractor_id === S.contractor);
    const mine = D.work_orders.filter((x) => x.contractor_id === S.contractor && x.flags.some(isMoney)).sort((a, b) => b.recoverable_inr - a.recoverable_inr).slice(0, 8);
    body = `<label class="field" style="margin-top:0"><select id="ct-sel" class="fsel">${D.contractors.map((x) => `<option value="${x.contractor_id}" ${x.contractor_id === S.contractor ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      <div class="sub">Grade <b>${c.grade}</b>, ${c.score}/100. Every flag is a question, and you have the right to reply. Replies appear on the job's evidence card for everyone.</div>
      <div class="list" style="margin-top:10px">${mine.map((x) => `<div class="item reply-item" data-rwo="${x.work_order_id}"><span class="rk" style="font-size:11px">${x.ward_code}</span><div><div class="w"><span class="link id" data-wo="${x.work_order_id}">${x.work_order_id}</span> · ${esc(topFlags(x).map((f) => FLAG[f.code]).join(", "))}</div><div class="s">${REPLIES[x.work_order_id] ? `Replied: ${esc(REPLIES[x.work_order_id].text.slice(0, 80))}${REPLIES[x.work_order_id].text.length > 80 ? "…" : ""}` : `${inr(x.recoverable_inr)} to question · no reply yet`}</div></div><div class="c"><button class="btn" data-replyto="${x.work_order_id}">${REPLIES[x.work_order_id] ? "Edit" : "Reply"}</button></div></div>`).join("")}</div>`;
  }
  $("#rail").insertAdjacentHTML("afterbegin", `<div class="card rolecard">${head}${body}<div class="draft" id="draft" hidden></div>${note}</div>`);
  $("#role-x").onclick = () => applyRole("");
  $$("#rail [data-lang]").forEach((b) => b.addEventListener("click", () => { S.lang = b.dataset.lang; render(); }));
  $$("#rail [data-draft]").forEach((b) => b.addEventListener("click", () => runDraft(b.dataset.draft, b)));
  $("#csv-juris")?.addEventListener("click", jurisCsv);
  $("#csv-packet")?.addEventListener("click", packetCsv);
  $("#ct-sel")?.addEventListener("change", (e) => { S.contractor = e.target.value; render(); setTimeout(() => document.getElementById("ct-" + S.contractor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); });
  $$("#rail [data-replyto]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); replyBox(b.dataset.replyto); }));
  const kind = { citizen: "citizen_letter", officer: "dlp_notice", corporator: "committee_questions" }[r];
  if (kind) runDraft(kind, null, true);
}

function draftKey(kind) { return kind === "citizen_letter" ? S.trace : S.ward; }
async function runDraft(kind, btn, cachedOnly) {
  const key = draftKey(kind);
  if (!key) return;
  const box = $("#draft");
  if (btn) { btn.disabled = true; btn.textContent = "Claude is drafting…"; }
  try {
    const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, key, lang: kind === "citizen_letter" ? S.lang : "en", cached_only: !!cachedOnly }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "error");
    if (j.text) showDraft(kind, key, j.text);
  } catch (e) {
    box.hidden = false;
    box.innerHTML = `<span class="t3">Claude is not available (${esc(e.message)}).</span>`;
  }
  if (btn) { btn.disabled = false; btn.textContent = "Redraft"; }
  status();
}
function showDraft(kind, key, text) {
  const box = $("#draft");
  box.hidden = false;
  const name = { citizen_letter: `letter-${key}`, dlp_notice: `dlp-notice-ward-${key.replace("/", "-")}`, committee_questions: `questions-ward-${key.replace("/", "-")}` }[kind];
  box.innerHTML = `<div class="narr">${linkify(text)}</div>
    <div class="actions"><button class="btn" id="d-copy">Copy</button><button class="btn" id="d-save">Download .txt</button>${kind === "citizen_letter" ? `<a class="btn" id="d-wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text.slice(0, 1500))}">Share on WhatsApp</a>` : ""}</div>
    <div class="sub t3" style="font-size:12px">Drafted by Claude from the audited record. Check it before sending.</div>`;
  bindLinks(box);
  $("#d-copy").onclick = async () => { try { await navigator.clipboard.writeText(text); $("#d-copy").textContent = "Copied"; } catch (e) { $("#d-copy").textContent = "Select and copy"; } };
  $("#d-save").onclick = () => download(`marg-${name}.txt`, text, "text/plain");
}
function download(name, body, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
}
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
function jurisCsv() {
  const rows = D.closed_unfixed.filter((x) => x.ward_code === S.ward);
  const ids = new Set(D.closed_unfixed_ids);
  const comps = D.complaints.filter((c) => ids.has(c.complaint_id) && c.ward_filled === S.ward);
  const head = ["complaint_id", "received_at", "status", "issue_type", "road_id", "road_name", "locality", "bmc_spend_on_road_inr", "verified_jurisdiction", "action_taken"];
  const spend = {}; rows.forEach((x) => (spend[x.road_id] = x.bmc_spend_on_road_inr));
  const body = [head.join(","), ...comps.map((c) => [c.complaint_id, c.received_at, c.status, c.issue_type, c.road_guess, (ROAD[c.road_guess] || {}).name, c.locality_std, spend[c.road_guess] || "", "", ""].map(q).join(","))].join("\n");
  download(`marg-jurisdiction-checklist-ward-${S.ward.replace("/", "-")}.csv`, body, "text/csv");
}
function packetCsv() {
  const saved = S.budget; S.budget = null;
  const items = planItems().filter((x) => x.fits).map((x) => x.p);
  S.budget = saved;
  const head = ["rank", "issue_id", "issue_type", "road_id", "road_name", "locality", "risk", "method", "est_cost_inr", "dlp_note", "complaint_ids", "why"];
  const body = [head.join(","), ...items.map((p) => [p.ward_rank, p.issue_id, p.issue_type, p.road_id, p.road_name, p.locality, Math.round(p.risk), p.method, p.est_cost_inr, p.dlp_note || "", p.complaint_ids.join(" "), p.reasons.join("; ")].map(q).join(","))].join("\n");
  download(`marg-work-packet-ward-${S.ward.replace("/", "-")}.csv`, body, "text/csv");
}
function replyBox(woId) {
  const w = WO[woId];
  const cur = REPLIES[woId] ? REPLIES[woId].text : "";
  card(`<div class="t3 mono">${woId} · right of reply</div><h2>${esc(w.contractor_name)}</h2>
    <div class="sub">${esc(topFlags(w)[0]?.why || "")}</div>
    <textarea id="reply-t" class="replyta" maxlength="600" placeholder="Context the audit may have missed: rain, permits, utility trenches, a change in scope…">${esc(cur)}</textarea>
    <div class="actions"><button class="btn light" id="reply-send">Post reply</button><span class="t3" id="reply-msg" style="font-size:12px"></span></div>
    <div class="sub t3" style="font-size:12px">Shown on this job's evidence card for everyone. 10 to 600 characters.</div>`, roadMid(w.road_id));
  $("#reply-send").onclick = async () => {
    const text = $("#reply-t").value.trim();
    try {
      const r = await fetch("/api/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ work_order_id: woId, contractor_id: w.contractor_id, text }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "error");
      REPLIES[woId] = { contractor_id: w.contractor_id, text, at: "just now" };
      render();
      showWo(woId);
    } catch (e) { $("#reply-msg").textContent = e.message; }
  };
}
