const identityKey = "catalyst-watch-installation-v1";
const $ = (id) => document.getElementById(id);
let identity, snapshot, loading = false;
try { identity = JSON.parse(localStorage.getItem(identityKey)); } catch {}
if (!identity || !/^[0-9a-f-]{36}$/i.test(identity.installationId) || !/^[0-9a-f]{64}$/i.test(identity.clientToken)) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  identity = { installationId: crypto.randomUUID(), clientToken: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") };
  localStorage.setItem(identityKey, JSON.stringify(identity));
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(12000),
    headers: { "x-installation-id": identity.installationId, "x-client-token": identity.clientToken, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}
function localTime(value) { return value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Waiting for first capture"; }
function text(id, value) { $(id).textContent = value; }
function render() {
  const s = snapshot;
  $("dashboard").hidden = false;
  $("access-panel").hidden = true;
  text("health", s.healthy ? "Collecting normally" : s.enabled ? "Needs attention" : "Monitor disabled");
  text("updated", `Last heartbeat · ${localTime(s.updatedAt)}`);
  for (const [id, key] of [["versions", "articleVersions"], ["mentions", "candidateVersions"], ["prospective", "prospectiveEvents"], ["signals", "qualifiedSignals"]]) text(id, Number(s[key] || 0).toLocaleString());
  text("capture-start", localTime(s.captureStartedAt));
  text("news-state", s.news?.completedAt ? `Latest scan · ${localTime(s.news.completedAt)}` : "Waiting for first complete scan");
  text("quote-state", `${s.quotes?.connection || "Starting"} · ${s.quotes?.sessions || 0} recorded sessions`);
  $("news-dot").className = `status-dot ${s.news && !s.newsError ? "ok" : "bad"}`;
  $("quote-dot").className = `status-dot ${s.quotes?.healthy ? "ok" : "bad"}`;
  const errors = [s.workerError, s.newsError, s.featureError, s.storageError];
  if (s.quotes?.enabled && !s.quotes.healthy) errors.push(s.quotes.recentErrors?.at(-1)?.message || "Quote coverage has not yet been verified.");
  if (s.heartbeatAgeSeconds > 180 || !s.workerRunning) errors.push("The collector heartbeat is stale or its process is unavailable.");
  if (s.unrecoveredGapBefore) errors.push(`An older collection gap remains before ${localTime(s.unrecoveredGapBefore)}.`);
  $("error").hidden = !errors.some(Boolean);
  text("error", errors.filter(Boolean).join(" "));
  renderEvents();
}
function renderEvents() {
  const filter = $("filter").value;
  const rows = (snapshot?.events || []).filter((e) => filter === "signals" ? e.feature?.signal : filter === "rejected" ? ["feature_rejected", "headline_rejected_after_revision"].includes(e.status) : filter === "prospective" ? e.evidence_class === "prospective_capture" : true);
  const tbody = $("events"); tbody.replaceChildren();
  $("empty").hidden = rows.length > 0;
  text("empty", filter !== "all" ? "No candidates match this filter." : snapshot?.enabled ? "No qualifying announcements have been captured yet. The monitor is watching." : "No announcements to display. The monitor is disabled.");
  for (const e of rows) {
    const tr = document.createElement("tr");
    const company = document.createElement("td"), ticker = document.createElement("strong"), headline = document.createElement("p");
    ticker.textContent = e.Ticker; headline.textContent = e.headline; company.append(ticker, headline);
    const day = document.createElement("td"); day.textContent = e.event_date;
    const evidence = document.createElement("p"); evidence.textContent = e.evidence_class === "prospective_capture" ? "Observed on time" : "Late discovery · excluded"; day.append(evidence);
    const amount = document.createElement("td"); amount.textContent = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(e.authorization_dollars);
    const decision = document.createElement("td"), pill = document.createElement("span"), detail = document.createElement("p");
    const passed = e.feature?.signal, rejected = ["feature_rejected", "headline_rejected_after_revision"].includes(e.status);
    pill.className = `pill ${passed ? "pass" : rejected ? "reject" : ""}`;
    pill.textContent = passed ? "Filters passed" : rejected ? "Rejected" : "Awaiting daily bars";
    const failures = Object.entries(e.feature || {}).filter(([key, value]) => key.startsWith("clause_") && !value).map(([key]) => key.replace("clause_", "").replaceAll("_", " "));
    detail.textContent = passed ? `Entry ${e.entry_date} · limit $${Number(e.entry_limit).toFixed(2)} · exit ${e.exit_date}` : failures.join(" · ") || (e.feature?.failure_reason && e.feature.failure_reason !== "ok" ? e.feature.failure_reason.replaceAll("_", " ") : "Evaluation follows the event session close.");
    decision.append(pill, detail); tr.append(company, day, amount, decision); tbody.append(tr);
  }
}
async function refresh() {
  if (loading) return;
  loading = true; $("refresh").disabled = true;
  try { snapshot = await api("/api/buyback/status"); render(); }
  catch (error) {
    text("health", "Status unavailable");
    if (error.status === 401 || error.status === 403) { $("access-panel").hidden = false; $("dashboard").hidden = true; }
    else { $("error").hidden = false; text("error", "The server could not be reached. Displayed records may be stale; retry shortly."); }
  } finally { loading = false; $("refresh").disabled = false; }
}
$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault(); text("access-error", "");
  try { await api("/api/entitlements/developer", { credential: $("credential").value }); $("credential").value = ""; await refresh(); }
  catch (error) { text("access-error", error.message); }
});
$("refresh").addEventListener("click", refresh); $("filter").addEventListener("change", renderEvents);
api("/api/installations", identity).then(refresh).catch(() => { text("health", "Unable to connect"); $("error").hidden = false; text("error", "Could not restore this browser's access. Check the connection and refresh."); });
setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
