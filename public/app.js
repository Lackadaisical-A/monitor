const state = {
  token: sessionStorage.getItem("catalyst-dashboard-token") || "",
  entries: [],
  status: null,
  filter: "all",
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

const elements = {
  overlay: document.querySelector("#auth-overlay"),
  authForm: document.querySelector("#auth-form"),
  tokenInput: document.querySelector("#token-input"),
  authError: document.querySelector("#auth-error"),
  connection: document.querySelector("#connection"),
  scanButton: document.querySelector("#scan-button"),
  signalList: document.querySelector("#signal-list"),
  sourceList: document.querySelector("#source-list"),
  dialog: document.querySelector("#signal-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast"),
};

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = elements.tokenInput.value;
  try {
    await refresh();
    sessionStorage.setItem("catalyst-dashboard-token", state.token);
    elements.overlay.classList.add("hidden");
    elements.authError.textContent = "";
  } catch (error) {
    elements.authError.textContent = error.message === "unauthorized" ? "That token was not accepted." : "Could not reach the monitor.";
  }
});

elements.scanButton.addEventListener("click", async () => {
  elements.scanButton.disabled = true;
  elements.scanButton.classList.add("scanning");
  try {
    const result = await api("/api/scan", { method: "POST" });
    toast(result.alreadyRunning ? "A scan is already in progress." : `Scan complete · ${result.insertedCount} new · ${result.analyzedCount} analyzed`);
    await refresh();
  } catch (error) {
    toast(`Scan failed: ${error.message}`);
  } finally {
    elements.scanButton.disabled = false;
    elements.scanButton.classList.remove("scanning");
  }
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    renderSignals();
  });
});

elements.signalList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-signal-id]");
  if (!row) return;
  const entry = state.entries.find((candidate) => candidate.item.id === row.dataset.signalId);
  if (entry) openSignal(entry);
});

elements.signalList.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const row = event.target.closest("[data-signal-id]");
  if (!row) return;
  event.preventDefault();
  const entry = state.entries.find((candidate) => candidate.item.id === row.dataset.signalId);
  if (entry) openSignal(entry);
});

document.querySelector("#dialog-close").addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

async function refresh() {
  try {
    const [status, feed] = await Promise.all([api("/api/status"), api("/api/feed?limit=150")]);
    state.status = status;
    state.entries = feed.entries;
    renderStatus();
    renderSignals();
    setConnection("online", "Live");
  } catch (error) {
    setConnection("error", "Disconnected");
    if (error.message === "unauthorized") elements.overlay.classList.remove("hidden");
    throw error;
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function renderStatus() {
  const { stats, sources, configuration } = state.status;
  text("#urgent-count", stats.urgent_count || 0);
  text("#analyzed-count", stats.analyzed_count || 0);
  text("#source-count", configuration.sourceCount);
  text("#device-count", stats.deviceCount || 0);
  text("#device-note", configuration.dryRun ? "Dry run — pushes logged only" : "Active APNs devices");
  text("#analysis-mode", configuration.analysisMode);
  text("#model-name", configuration.model);
  text("#thresholds", `materiality ≥ ${configuration.urgentThresholds.materiality}  ·  confidence ≥ ${Math.round(configuration.urgentThresholds.confidence * 100)}%  ·  APNs ${configuration.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!sources.length) {
    elements.sourceList.innerHTML = '<div class="empty-state"><p>No source has completed a fetch yet.</p></div>';
    return;
  }
  elements.sourceList.innerHTML = sources.map((source) => `
    <div class="source-row">
      <span class="source-status ${source.lastError ? "error" : ""}"></span>
      <div>
        <div class="source-name">${escapeHtml(prettySource(source.sourceId))}</div>
        <div class="source-sub">${source.lastError ? escapeHtml(truncate(source.lastError, 90)) : "Healthy · official API/feed"}</div>
      </div>
      <div class="source-time">${source.lastFetchedAt ? relativeTime(source.lastFetchedAt) : "Never"}</div>
    </div>
  `).join("");
}

function renderSignals() {
  const filtered = state.entries.filter((entry) => {
    if (!entry.analysis) return state.filter === "all";
    return state.filter === "all" || entry.analysis.alertTier === state.filter;
  });
  if (!filtered.length) {
    elements.signalList.innerHTML = `<div class="empty-state"><p>No ${state.filter === "all" ? "signals" : `${state.filter} signals`} yet.<br />Run a scan after configuring your watchlist.</p></div>`;
    return;
  }
  elements.signalList.innerHTML = filtered.map((entry) => {
    const { item, analysis } = entry;
    const assessment = analysis?.assessment;
    const ticker = assessment?.ticker || item.tickerHint || "—";
    const tier = analysis?.alertTier || "none";
    const direction = assessment?.stockDirection || "unclear";
    const confidence = Math.round((assessment?.confidence || 0) * 100);
    return `
      <article class="signal-row" data-signal-id="${escapeHtml(item.id)}" tabindex="0">
        <div class="ticker-block">
          <strong>${escapeHtml(ticker)}</strong>
          <span>${escapeHtml(phaseLabel(assessment?.trialPhase))}</span>
        </div>
        <div class="signal-copy">
          <div class="signal-title">${escapeHtml(item.headline)}</div>
          <div class="signal-meta">
            <span class="tier ${tier}">${tier}</span><i></i>
            <span class="direction ${direction}">${escapeHtml(direction)}</span><i></i>
            <span>${escapeHtml(item.source.name)}</span>
            ${entry.corroborationCount ? `<i></i><span>${entry.corroborationCount + 1} sources</span>` : ""}
          </div>
        </div>
        <div class="score-block">
          <strong>${assessment?.materiality ?? "—"}</strong><span>materiality</span>
          <div class="confidence-bar"><span style="width:${confidence}%"></span></div>
        </div>
        <div class="time-block"><strong>${relativeTime(item.publishedAt)}</strong><span>${confidence}% confidence</span></div>
      </article>
    `;
  }).join("");
}

function openSignal(entry) {
  const { item, analysis } = entry;
  if (!analysis) {
    elements.dialogContent.innerHTML = `<div class="dialog-body"><h2 class="dialog-title">${escapeHtml(item.headline)}</h2><p class="dialog-source">Awaiting analysis · ${escapeHtml(item.source.name)}</p><a class="source-link" href="${safeUrl(item.url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a></div>`;
    elements.dialog.showModal();
    return;
  }
  const a = analysis.assessment;
  elements.dialogContent.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-kicker"><span class="tier ${analysis.alertTier}">${analysis.alertTier}</span><span class="direction ${a.stockDirection}">${escapeHtml(a.stockDirection)}</span></div>
      <h2 class="dialog-title">${escapeHtml(item.headline)}</h2>
      <div class="dialog-source">${escapeHtml(item.source.name)} · ${formatDate(item.publishedAt)} · ${escapeHtml(analysis.method === "openai" ? analysis.model : "demo heuristic")}</div>
      <div class="score-grid">
        <div class="score-cell"><span>Materiality</span><strong>${a.materiality}/100</strong></div>
        <div class="score-cell"><span>Confidence</span><strong>${Math.round(a.confidence * 100)}%</strong></div>
        <div class="score-cell"><span>Scenario range</span><strong>${signed(a.expectedMoveLowPct)}–${signed(a.expectedMoveHighPct)}</strong></div>
      </div>
      <section class="detail-section"><h3>Why it may matter</h3><p>${escapeHtml(a.rationale)}</p></section>
      ${listSection("Evidence", a.evidence)}
      ${listSection("Uncertainty", a.uncertainty)}
      ${listSection("Disconfirming evidence", a.disconfirmingEvidence)}
      ${listSection("Alert policy", analysis.policyReasons)}
      <section class="detail-section"><h3>Clinical classification</h3><p>${escapeHtml(phaseLabel(a.trialPhase))} · ${escapeHtml(a.eventType.replaceAll("_", " "))} · primary endpoint: ${escapeHtml(a.primaryEndpointMet)} · safety: ${escapeHtml(a.safetyAssessment)}</p><a class="source-link" href="${safeUrl(item.url)}" target="_blank" rel="noopener noreferrer">Verify original source ↗</a></section>
    </div>`;
  elements.dialog.showModal();
}

function listSection(title, values) {
  if (!values?.length) return "";
  return `<section class="detail-section"><h3>${escapeHtml(title)}</h3><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul></section>`;
}

function text(selector, value) { document.querySelector(selector).textContent = String(value); }
function setConnection(kind, label) { elements.connection.className = `connection ${kind}`; elements.connection.lastChild.textContent = ` ${label}`; }
function signed(value) { return `${value > 0 ? "+" : ""}${Number(value).toFixed(0)}%`; }
function truncate(value, length) { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
function prettySource(value) { return value.split("-").map((word) => ["sec", "fda"].includes(word) ? word.toUpperCase() : word === "x" ? "X" : word.charAt(0).toUpperCase() + word.slice(1)).join(" "); }
function phaseLabel(value) {
  if (!value) return "Pending";
  if (value === "not_applicable") return "N/A";
  if (value === "post_market") return "Post-market";
  if (value === "preclinical") return "Preclinical";
  if (value === "unknown") return "Unknown";
  return value.replace("phase_", "Phase ").replaceAll("_", "/");
}
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function relativeTime(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
function safeUrl(value) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.toString()) : "#"; } catch { return "#"; } }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function toast(message) { elements.toast.textContent = message; elements.toast.classList.add("show"); setTimeout(() => elements.toast.classList.remove("show"), 3200); }

refresh().then(() => elements.overlay.classList.add("hidden")).catch(() => {});
setInterval(() => refresh().catch(() => {}), 15_000);
