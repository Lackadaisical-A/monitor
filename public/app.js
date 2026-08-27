const IDENTITY_KEY = "catalyst-watch-installation-v1";
const CACHE_KEY = "catalyst-watch-web-cache-v6";
const EVENT_TYPES = [
  "trial_topline", "trial_update", "regulatory_decision", "regulatory_update",
  "safety_signal", "publication", "financing", "partnership", "other",
];

const state = {
  identity: loadIdentity(),
  access: null,
  products: [],
  freeFeedDelayMinutes: 30,
  entries: [],
  timeline: [],
  timelineSummary: null,
  status: null,
  watchlist: [],
  preferences: {
    watchedTickers: [],
    feedMode: "all",
    pushMode: "all",
    eventTypes: [...EVENT_TYPES],
  },
  watchlistLimit: 10,
  monitoredUniverse: 0,
  selectedId: null,
  tier: "all",
  signalQuery: "",
  watchlistQuery: "",
  watchlistScope: "all",
  marketCap: "all",
  timelineStatus: "all",
  timelineQuery: "",
  lastUpdatedAt: null,
  refreshing: false,
};

const elements = {
  connection: document.querySelector("#connection"),
  tierButton: document.querySelector("#tier-button"),
  tierLabel: document.querySelector("#tier-label"),
  refreshButton: document.querySelector("#refresh-button"),
  scanButton: document.querySelector("#scan-button"),
  signalList: document.querySelector("#signal-list"),
  detailPane: document.querySelector("#detail-pane"),
  signalDialog: document.querySelector("#signal-dialog"),
  signalDialogContent: document.querySelector("#signal-dialog-content"),
  settingsDialog: document.querySelector("#settings-dialog"),
  sourceList: document.querySelector("#source-list"),
  timelineList: document.querySelector("#timeline-list"),
  timelineSearch: document.querySelector("#timeline-search"),
  timelineStatus: document.querySelector("#timeline-status"),
  watchlistGrid: document.querySelector("#watchlist-grid"),
  signalSearch: document.querySelector("#signal-search"),
  mobileSignalSearch: document.querySelector("#mobile-signal-search"),
  watchlistSearch: document.querySelector("#watchlist-search"),
  marketCapFilter: document.querySelector("#market-cap-filter"),
  feedScope: document.querySelector("#feed-scope"),
  watchlistScope: document.querySelector("#watchlist-scope"),
  developerForm: document.querySelector("#developer-form"),
  developerCredential: document.querySelector("#developer-credential"),
  developerError: document.querySelector("#developer-error"),
  toast: document.querySelector("#toast"),
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

elements.tierButton.addEventListener("click", openSettings);
document.querySelector("#access-action").addEventListener("click", openSettings);
document.querySelector("#settings-close").addEventListener("click", () => elements.settingsDialog.close());
document.querySelector("#signal-dialog-close").addEventListener("click", () => elements.signalDialog.close());

for (const dialog of [elements.settingsDialog, elements.signalDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

elements.refreshButton.addEventListener("click", () => refresh({ forceWatchlist: false }));
elements.scanButton.addEventListener("click", runScan);

document.querySelectorAll('input[name="tier"]').forEach((input) => {
  input.addEventListener("change", () => setTier(input.value));
});

document.querySelector("#mobile-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tier]");
  if (button) setTier(button.dataset.tier);
});

document.querySelector("#clear-filters").addEventListener("click", () => {
  state.signalQuery = "";
  elements.signalSearch.value = "";
  elements.mobileSignalSearch.value = "";
  setTier("all");
});

for (const input of [elements.signalSearch, elements.mobileSignalSearch]) {
  input.addEventListener("input", () => {
    state.signalQuery = input.value.trim().toLowerCase();
    elements.signalSearch.value = input.value;
    elements.mobileSignalSearch.value = input.value;
    renderSignals();
  });
}

elements.signalList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-signal-id]");
  if (row) selectSignal(row.dataset.signalId);
});

elements.watchlistSearch.addEventListener("input", () => {
  state.watchlistQuery = elements.watchlistSearch.value.trim().toLowerCase();
  renderWatchlist();
});

elements.marketCapFilter.addEventListener("change", () => {
  state.marketCap = elements.marketCapFilter.value;
  renderWatchlist();
});

elements.feedScope.addEventListener("click", (event) => {
  const button = event.target.closest("[data-feed-scope]");
  if (button) setFeedScope(button.dataset.feedScope);
});

elements.watchlistScope.addEventListener("click", (event) => {
  const button = event.target.closest("[data-watchlist-scope]");
  if (!button) return;
  state.watchlistScope = button.dataset.watchlistScope === "followed" ? "followed" : "all";
  renderWatchlist();
});

elements.watchlistGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-follow-ticker]");
  if (button) toggleFollow(button.dataset.followTicker, button);
});

elements.sourceList.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-settings]")) openSettings();
});

elements.timelineSearch.addEventListener("input", () => {
  state.timelineQuery = elements.timelineSearch.value.trim().toLowerCase();
  renderTimeline();
});

elements.timelineStatus.addEventListener("click", (event) => {
  const button = event.target.closest("[data-timeline-status]");
  if (!button) return;
  state.timelineStatus = ["upcoming", "completed"].includes(button.dataset.timelineStatus)
    ? button.dataset.timelineStatus : "all";
  renderTimeline();
});

elements.timelineList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-timeline-id]");
  if (row) openTimelineEvent(row.dataset.timelineId);
});

elements.developerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.developerError.textContent = "";
  const submit = elements.developerForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const response = await api("/api/entitlements/developer", {
      method: "POST",
      body: { credential: elements.developerCredential.value },
    });
    state.access = response.access;
    state.products = response.products;
    state.freeFeedDelayMinutes = response.freeFeedDelayMinutes;
    elements.developerCredential.value = "";
    renderAccess();
    await loadPreferences();
    await refresh({ forceWatchlist: false });
    toast("Developer access is active on this browser.");
  } catch (error) {
    elements.developerError.textContent = error.message === "Developer credential was not accepted"
      ? "Credential not accepted."
      : "Could not activate developer access.";
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.lastUpdatedAt
    && Date.now() - Date.parse(state.lastUpdatedAt) > 300_000) {
    refresh({ forceWatchlist: false });
  }
});

async function initialize() {
  restoreCache();
  renderAll();
  switchView(initialView(), false);
  await registerInstallation();
  await loadPreferences();
  await refresh({ forceWatchlist: true });
  setInterval(() => refresh({ forceWatchlist: false }), 300_000);
}

async function loadPreferences() {
  const response = await api("/api/preferences");
  applyPreferencesResponse(response);
}

async function registerInstallation(canReset = true) {
  try {
    const response = await api("/api/installations", {
      method: "POST",
      body: state.identity,
      authenticated: false,
    });
    state.access = response.access;
    state.products = response.products;
    state.freeFeedDelayMinutes = response.freeFeedDelayMinutes;
    renderAccess();
  } catch (error) {
    if (canReset && error.status === 401) {
      state.identity = createIdentity();
      persistIdentity(state.identity);
      await registerInstallation(false);
      return;
    }
    throw error;
  }
}

async function refresh({ forceWatchlist }) {
  if (state.refreshing) return;
  state.refreshing = true;
  elements.refreshButton.classList.add("loading");
  try {
    const scope = state.preferences.feedMode === "watchlist" ? "watchlist" : "all";
    const requests = [
      api("/api/status"),
      api(`/api/feed?limit=150&scope=${scope}`),
      api(`/api/timeline?limit=500&scope=${scope}`),
    ];
    if (forceWatchlist || !state.watchlist.length) requests.push(api("/api/watchlist"));
    const responses = await Promise.all(requests);
    state.status = responses[0];
    state.entries = responses[1].entries;
    state.timeline = responses[2].events;
    state.timelineSummary = responses[2].summary;
    state.access = responses[1].access ?? state.status.access ?? state.access;
    state.freeFeedDelayMinutes = state.status.configuration.freeFeedDelayMinutes;
    if (responses[3]) {
      state.watchlist = responses[3].companies;
      state.watchlistLimit = responses[3].limit ?? state.watchlistLimit;
      if (responses[3].preferences) state.preferences = responses[3].preferences;
    }
    state.lastUpdatedAt = new Date().toISOString();
    persistCache();
    renderAll();
    setConnection("online", "Live");
  } catch (error) {
    setConnection("error", navigator.onLine ? "Unavailable" : "Offline");
    if (!state.entries.length) {
      elements.signalList.innerHTML = emptyState("Signal stream unavailable", "The monitor could not be reached.");
    }
  } finally {
    state.refreshing = false;
    elements.refreshButton.classList.remove("loading");
  }
}

async function setFeedScope(scope) {
  const next = scope === "watchlist" ? "watchlist" : "all";
  if (next === "watchlist" && !state.preferences.watchedTickers.length) {
    switchView("watchlist");
    toast("Follow at least one company first.");
    return;
  }
  if (next === state.preferences.feedMode) return;
  try {
    await savePreferences({ feedMode: next });
    state.selectedId = null;
    await refresh({ forceWatchlist: false });
  } catch (error) {
    toast(`Could not update feed: ${error.message}`);
  }
}

async function toggleFollow(ticker, button) {
  if (!ticker || button.disabled) return;
  const watched = new Set(state.preferences.watchedTickers);
  const adding = !watched.has(ticker);
  if (adding && watched.size >= state.watchlistLimit) {
    openSettings();
    toast(state.access?.pro ? "This watchlist is full." : "Upgrade to follow the complete monitored universe.");
    return;
  }
  adding ? watched.add(ticker) : watched.delete(ticker);
  button.disabled = true;
  try {
    await savePreferences({ watchedTickers: [...watched] });
    if (!watched.size && state.preferences.feedMode === "watchlist") {
      await savePreferences({ feedMode: "all" });
      await refresh({ forceWatchlist: false });
    }
    toast(adding ? `${ticker} added to your watchlist.` : `${ticker} removed from your watchlist.`);
  } catch (error) {
    toast(`Could not update watchlist: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function savePreferences(patch) {
  const next = { ...state.preferences, ...patch };
  const response = await api("/api/preferences", {
    method: "PUT",
    body: {
      watchedTickers: next.watchedTickers,
      feedMode: next.feedMode,
      pushMode: next.pushMode,
      eventTypes: next.eventTypes,
    },
  });
  applyPreferencesResponse(response);
  const followed = new Set(state.preferences.watchedTickers);
  state.watchlist = state.watchlist.map((company) => ({ ...company, followed: followed.has(company.ticker) }));
  persistCache();
  renderAll();
}

function applyPreferencesResponse(response) {
  if (response.access) state.access = response.access;
  if (response.preferences) state.preferences = response.preferences;
  if (response.limits) {
    state.watchlistLimit = response.limits.watchlist;
    state.monitoredUniverse = response.limits.monitoredUniverse;
  }
}

async function runScan() {
  if (!state.access?.pro) {
    openSettings();
    toast("Catalyst Watch Pro is required for manual scans.");
    return;
  }
  elements.scanButton.classList.add("loading");
  elements.scanButton.disabled = true;
  try {
    const result = await api("/api/scan", { method: "POST" });
    toast(result.alreadyRunning
      ? "A monitor scan is already running."
      : `Scan complete: ${result.insertedCount} new, ${result.analyzedCount} analyzed.`);
    await refresh({ forceWatchlist: false });
  } catch (error) {
    toast(`Scan failed: ${error.message}`);
  } finally {
    elements.scanButton.classList.remove("loading");
    elements.scanButton.disabled = false;
  }
}

async function api(path, options = {}) {
  const { authenticated = true, body, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (authenticated) {
    headers.set("x-installation-id", state.identity.installationId);
    headers.set("x-client-token", state.identity.clientToken);
  }
  let payload = body;
  if (body !== undefined && typeof body !== "string") {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(path, { ...fetchOptions, headers, body: payload });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderAll() {
  renderStatus();
  renderAccess();
  renderSignals();
  renderTimeline();
  renderWatchlist();
  renderSources();
}

function renderStatus() {
  if (!state.status) return;
  const { stats, configuration } = state.status;
  text("#watchlist-count", configuration.watchlistCount);
  text("#source-count", configuration.sourceCount);
  text("#analyzed-count", stats.analyzed_count || 0);
  text("#high-count", stats.high_count || 0);
  text("#urgent-count", stats.urgent_count || 0);
  text("#analysis-mode", configuration.analysisMode);
  text("#model-name", configuration.model);
  if (Number.isFinite(configuration.scanIntervalSeconds)) {
    text("#monitor-cadence", configuration.scanIntervalSeconds < 60
      ? `${configuration.scanIntervalSeconds} sec`
      : `${Math.round(configuration.scanIntervalSeconds / 60)} min`);
  }
  const highThresholds = configuration.highThresholds || { materiality: 70, confidence: 0.8 };
  text("#thresholds", `${highThresholds.materiality}/${Math.round(highThresholds.confidence * 100)} · ${configuration.urgentThresholds.materiality}/${Math.round(configuration.urgentThresholds.confidence * 100)}`);
}

function renderAccess() {
  const access = state.access ?? { level: "free", pro: false, source: "free", expiresAt: null };
  const level = access.level === "developer" ? "Developer" : access.pro ? "Pro" : "Free";
  elements.tierLabel.textContent = level;
  elements.tierButton.classList.toggle("pro", access.pro);
  elements.scanButton.setAttribute("aria-disabled", String(!access.pro));

  const banner = document.querySelector("#access-banner");
  banner.classList.toggle("pro", access.pro);
  text("#access-title", access.pro ? `${level} real-time feed` : "Free feed");
  text("#access-copy", access.pro
    ? "Live signals, full history, source health, manual scans, and phone alert eligibility."
    : `${state.freeFeedDelayMinutes} minute delay with the latest 30 signals.`);
  text("#access-action", access.pro ? "Manage" : "Upgrade");

  text("#settings-level", level);
  text("#settings-title", access.pro ? "Real-time intelligence" : "Delayed signal feed");
  text("#settings-expiry", access.expiresAt ? `Renews or expires ${formatDate(access.expiresAt)}`
    : access.level === "developer" ? "Owner entitlement" : "No active subscription");
  text("#plan-timing", access.pro ? "Real time" : `${state.freeFeedDelayMinutes} min delay`);
  text("#plan-depth", access.pro ? "150 signals" : "30 signals");
  text("#plan-scans", access.pro ? "Available" : "Locked");
  text("#plan-alerts", access.pro ? "Eligible" : "Locked");
  text("#plan-watchlist", access.pro ? "Full universe" : `${state.watchlistLimit} companies`);
  text("#installation-id", `${state.identity.installationId.slice(0, 8)}...${state.identity.installationId.slice(-4)}`);
}

function renderSignals() {
  const feedMode = state.preferences.feedMode === "watchlist" ? "watchlist" : "all";
  elements.feedScope.querySelectorAll("[data-feed-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.feedScope === feedMode);
  });
  text("#feed-followed-count", state.preferences.watchedTickers.length);
  const counts = { all: state.entries.length, urgent: 0, high: 0, watch: 0 };
  for (const entry of state.entries) {
    const tier = entry.analysis?.alertTier;
    if (tier && tier in counts) counts[tier] += 1;
  }
  for (const tier of ["all", "urgent", "high", "watch"]) text(`#filter-${tier}-count`, counts[tier]);

  const filtered = state.entries.filter((entry) => {
    const tier = entry.analysis?.alertTier ?? "none";
    if (state.tier !== "all" && tier !== state.tier) return false;
    if (!state.signalQuery) return true;
    const assessment = entry.analysis?.assessment;
    const acceptedAssessment = assessment?.isBiotechCatalyst ? assessment : null;
    return [entry.item.headline, entry.item.summary, entry.item.source.name, displayTicker(entry),
      entry.analysis ? acceptedAssessment?.companyName : entry.item.companyHint]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(state.signalQuery);
  });

  text("#feed-state", `${feedMode === "watchlist" ? "Following" : "All companies"} · ${filtered.length} signal${filtered.length === 1 ? "" : "s"}${state.lastUpdatedAt ? ` · ${relativeTime(state.lastUpdatedAt)}` : ""}`);
  if (!filtered.length) {
    elements.signalList.innerHTML = emptyState(
      state.entries.length ? "No matching signals" : "No signals yet",
      state.entries.length ? "Change the search or priority filter." : "The monitor will add catalysts as sources publish them.",
    );
    return;
  }

  elements.signalList.innerHTML = filtered.map((entry) => {
    const { item, analysis } = entry;
    const assessment = analysis?.assessment;
    const ticker = displayTicker(entry) || "--";
    const tier = analysis?.alertTier || "none";
    const tierLabel = analysis?.alertTier || "pending";
    const confidence = Math.round((assessment?.confidence || 0) * 100);
    return `
      <button class="signal-row ${state.selectedId === item.id ? "selected" : ""}" data-signal-id="${escapeHtml(item.id)}" type="button">
        <span class="ticker-cell">
          <strong>${escapeHtml(ticker)}</strong>
          <span class="${tier}">${escapeHtml(tierLabel)}</span>
        </span>
        <span class="signal-copy">
          <span class="signal-title">${escapeHtml(item.headline)}</span>
          <span class="signal-meta">
            <span class="source-meta">${escapeHtml(item.source.name)}</span><i></i>
            <span>${relativeTime(item.publishedAt)}</span>
            ${entry.corroborationCount ? `<i></i><span>${entry.corroborationCount + 1} sources</span>` : ""}
            ${movementInline(entry.marketMovement)}
          </span>
        </span>
        <span class="signal-score">
          <strong>${assessment?.marketMateriality ?? assessment?.materiality ?? "--"}</strong>
          <small>${confidence}% conf.</small>
          <span class="mini-bar"><span style="width:${confidence}%"></span></span>
        </span>
      </button>`;
  }).join("");

  if (!state.selectedId && window.matchMedia("(min-width: 1221px)").matches) {
    selectSignal(filtered[0].item.id, false);
  }
}

function selectSignal(itemId, openDialog = true) {
  const entry = state.entries.find((candidate) => candidate.item.id === itemId);
  if (!entry) return;
  state.selectedId = itemId;
  elements.signalList.querySelectorAll("[data-signal-id]").forEach((row) => {
    row.classList.toggle("selected", row.dataset.signalId === itemId);
  });
  const content = signalDetail(entry);
  elements.detailPane.innerHTML = content;
  elements.signalDialogContent.innerHTML = content;
  if (openDialog && window.matchMedia("(max-width: 1220px)").matches && !elements.signalDialog.open) {
    elements.signalDialog.showModal();
  }
}

function signalDetail(entry) {
  const { item, analysis } = entry;
  if (!analysis) {
    return `<div class="detail-content">
      <div class="detail-kicker"><span>Pending</span><time>${relativeTime(item.publishedAt)}</time></div>
      <h2>${escapeHtml(item.headline)}</h2>
      <div class="detail-source">${escapeHtml(item.source.name)} · ${formatDate(item.publishedAt)}</div>
      <section class="detail-section"><h3>Analysis</h3><p>This item is queued for evidence classification.</p></section>
      ${sourceLink(item.url)}
    </div>`;
  }
  const assessment = analysis.assessment;
  const movement = entry.marketMovement;
  const range = `${signed(assessment.expectedMoveLowPct)} to ${signed(assessment.expectedMoveHighPct)}`;
  return `<div class="detail-content">
    <div class="detail-kicker"><span>${escapeHtml(analysis.alertTier)}</span><time>${relativeTime(item.publishedAt)}</time></div>
    <h2>${escapeHtml(item.headline)}</h2>
    <div class="detail-source">${escapeHtml(item.source.name)} · ${formatDate(item.publishedAt)} · ${escapeHtml(analysis.model)}</div>
    <div class="score-strip">
      <div><span>Market materiality</span><strong>${assessment.marketMateriality ?? assessment.materiality}/100</strong></div>
      <div><span>Confidence</span><strong>${Math.round(assessment.confidence * 100)}%</strong></div>
      <div><span>Scenario range</span><strong>${escapeHtml(range)}</strong></div>
      ${movement ? `<div><span>${escapeHtml(movementWindowTitle(movement))}</span><strong class="movement-value ${movementClass(movement.changePct)}">${marketSigned(movement.changePct)}</strong></div>` : ""}
    </div>
    ${marketMovementPanel(movement)}
    <section class="detail-section"><h3>Assessment</h3><p>${escapeHtml(assessment.rationale)}</p></section>
    ${detailList("Evidence", assessment.evidence)}
    ${detailList("Uncertainty", assessment.uncertainty)}
    ${detailList("Disconfirming evidence", assessment.disconfirmingEvidence)}
    ${detailList("Alert gate", analysis.policyReasons)}
    <section class="detail-section"><h3>Classification</h3><p>${escapeHtml(phaseLabel(assessment.trialPhase))} · ${escapeHtml(prettyLabel(assessment.eventType))} · endpoint ${escapeHtml(prettyLabel(assessment.primaryEndpointMet))} · safety ${escapeHtml(prettyLabel(assessment.safetyAssessment))}</p>${sourceLink(item.url)}</section>
  </div>`;
}

function renderTimeline() {
  const summary = state.timelineSummary || {
    upcomingCount: state.timeline.filter((event) => event.status === "upcoming").length,
    completedCount: state.timeline.filter((event) => event.status === "completed").length,
    benchmarkedCount: state.timeline.filter((event) => event.outcome?.abnormalReturnPct != null).length,
    expectationMatchedCount: state.timeline.filter((event) => event.expectationEventId).length,
  };
  text("#timeline-upcoming-count", summary.upcomingCount || 0);
  text("#timeline-completed-count", summary.completedCount || 0);
  text("#timeline-benchmarked-count", summary.benchmarkedCount || 0);
  text("#timeline-matched-count", summary.expectationMatchedCount || 0);
  text("#timeline-updated", state.lastUpdatedAt ? relativeTime(state.lastUpdatedAt) : "--");
  elements.timelineStatus.querySelectorAll("[data-timeline-status]").forEach((button) => {
    button.classList.toggle("active", button.dataset.timelineStatus === state.timelineStatus);
  });

  const filtered = state.timeline.filter((event) => {
    if (state.timelineStatus !== "all" && event.status !== state.timelineStatus) return false;
    if (!state.timelineQuery) return true;
    return [event.ticker, event.companyName, event.program, event.indication, event.title,
      event.summary, event.eventType, event.sourceName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(state.timelineQuery);
  });
  const upcoming = filtered.filter((event) => event.status === "upcoming")
    .sort((left, right) => Date.parse(left.eventDate) - Date.parse(right.eventDate));
  const completed = filtered.filter((event) => event.status === "completed")
    .sort((left, right) => Date.parse(right.eventDate) - Date.parse(left.eventDate));
  const sections = [];
  if (state.timelineStatus !== "completed" && upcoming.length) {
    sections.push(timelineSection("Upcoming", upcoming, "Company guidance and registered trial dates"));
  }
  if (state.timelineStatus !== "upcoming" && completed.length) {
    sections.push(timelineSection("Completed", completed, "Original alert scores with post-event calibration"));
  }
  elements.timelineList.innerHTML = sections.length ? sections.join("") : emptyState(
    state.timeline.length ? "No matching timeline events" : "No timeline events yet",
    state.timeline.length ? "Change the search or status filter." : "Milestones appear as monitored sources publish guidance and results.",
  );
}

function timelineSection(title, events, subtitle) {
  return `<section class="timeline-section">
    <header><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span><b>${events.length}</b></header>
    <div>${events.map(timelineRow).join("")}</div>
  </section>`;
}

function timelineRow(event) {
  const date = timelineDateParts(event);
  const outcome = event.outcome;
  const calibrated = outcome?.calibrationVersion >= 2;
  const guidancePassed = event.status === "upcoming" && Date.parse(event.eventDate) < Date.now();
  const expectationMetrics = event.status === "upcoming"
    ? [
      timelineMetric("Anticipated", scoreValue(event.anticipatedMateriality)),
      event.expectedSuccessProbability == null ? "" : timelineMetric("Model odds", probability(event.expectedSuccessProbability)),
    ].join("")
    : [
      timelineMetric("Initial", scoreValue(event.initialMateriality)),
      event.expectationEventId && event.anticipatedMateriality != null
        ? timelineMetric("Anticipated", scoreValue(event.anticipatedMateriality)) : "",
    ].join("");
  const realizedMetrics = event.status === "upcoming"
    ? timelineMetric("Confidence", probability(event.expectationConfidence), "muted")
    : [
      timelineMetric("Post-event", calibrated ? scoreValue(outcome.surpriseAdjustedMateriality) : "Pending"),
      timelineMetric(
        calibrated && outcome.abnormalReturnPct != null ? "XBI-adjusted" : "Return",
        outcome ? marketSigned(calibrated && outcome.abnormalReturnPct != null ? outcome.abnormalReturnPct : outcome.actualReturnPct) : "Pending",
        outcome ? movementClass(calibrated && outcome.abnormalReturnPct != null ? outcome.abnormalReturnPct : outcome.actualReturnPct) : "muted",
      ),
    ].join("");
  return `<button class="timeline-row ${escapeHtml(event.status)}" data-timeline-id="${escapeHtml(event.id)}" type="button">
    <time class="timeline-date" datetime="${escapeHtml(event.eventDate)}"><strong>${escapeHtml(date.primary)}</strong><span>${escapeHtml(date.secondary)}</span>${guidancePassed ? "<em>Guidance passed</em>" : ""}</time>
    <span class="timeline-rail"><i></i></span>
    <span class="timeline-copy">
      <span class="timeline-badges"><b>${escapeHtml(event.ticker)}</b><em>${escapeHtml(prettyLabel(event.eventType))}</em>${event.alertTier ? `<em class="${escapeHtml(event.alertTier)}">${escapeHtml(event.alertTier)}</em>` : ""}</span>
      <strong>${escapeHtml(event.title)}</strong>
      <small>${escapeHtml([event.program, event.indication, event.sourceName].filter(Boolean).join(" · "))}</small>
    </span>
    <span class="timeline-metrics expectation">${expectationMetrics}</span>
    <span class="timeline-metrics realized">${realizedMetrics}</span>
  </button>`;
}

function timelineMetric(label, value, className = "") {
  return `<span class="timeline-metric ${escapeHtml(className)}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`;
}

function openTimelineEvent(eventId) {
  const event = state.timeline.find((candidate) => candidate.id === eventId);
  if (!event) return;
  elements.signalDialogContent.innerHTML = timelineDetail(event);
  if (!elements.signalDialog.open) elements.signalDialog.showModal();
}

function timelineDetail(event) {
  const outcome = event.outcome;
  const calibrated = outcome?.calibrationVersion >= 2;
  const dateChanged = event.initialEventDate && event.initialEventDate !== event.eventDate;
  const range = outcome ? `${signed(outcome.expectedMoveLowPct)} to ${signed(outcome.expectedMoveHighPct)}` : null;
  const scoreCards = event.status === "upcoming"
    ? `<div class="score-strip">
        <div><span>Anticipated materiality</span><strong>${scoreValue(event.anticipatedMateriality)}</strong></div>
        <div><span>Model outcome odds</span><strong>${probability(event.expectedSuccessProbability)}</strong></div>
        <div><span>Expectation confidence</span><strong>${probability(event.expectationConfidence)}</strong></div>
      </div>`
    : `<div class="score-strip">
        <div><span>Original materiality</span><strong>${scoreValue(event.initialMateriality)}</strong></div>
        <div><span>Post-event materiality</span><strong>${calibrated ? scoreValue(outcome.surpriseAdjustedMateriality) : "Pending"}</strong></div>
        <div><span>Original scenario</span><strong>${escapeHtml(range || "--")}</strong></div>
        ${outcome ? `<div><span>${outcome.abnormalReturnPct != null ? "XBI-adjusted return" : "Observed return"}</span><strong class="${movementClass(outcome.abnormalReturnPct ?? outcome.actualReturnPct)}">${marketSigned(outcome.abnormalReturnPct ?? outcome.actualReturnPct)}</strong></div>` : ""}
      </div>`;
  const expectation = event.expectedOutcome ? `<section class="detail-section"><h3>Expectation snapshot</h3><p>${escapeHtml(event.expectedOutcome)}</p><small class="snapshot-meta">${event.expectationAsOf ? `Frozen ${formatDate(event.expectationAsOf)}` : "Pre-event snapshot"}${event.clinicalSurpriseScore == null ? "" : ` · Clinical surprise ${signedPoints(event.clinicalSurpriseScore)}`}</small></section>` : "";
  const realized = outcome ? `<section class="outcome-grid">
      ${timelineOutcomeValue("Company return", marketSigned(outcome.actualReturnPct), movementClass(outcome.actualReturnPct))}
      ${timelineOutcomeValue("XBI return", outcome.benchmarkReturnPct == null ? "--" : marketSigned(outcome.benchmarkReturnPct), movementClass(outcome.benchmarkReturnPct))}
      ${timelineOutcomeValue("Abnormal return", outcome.abnormalReturnPct == null ? "--" : marketSigned(outcome.abnormalReturnPct), movementClass(outcome.abnormalReturnPct))}
      ${timelineOutcomeValue("Market surprise", signedPoints(outcome.marketSurpriseScore), movementClass(outcome.marketSurpriseScore))}
    </section>` : "";
  return `<div class="detail-content timeline-detail">
    <div class="detail-kicker"><span>${escapeHtml(event.status)}</span><time>${escapeHtml(event.dateLabel)}</time></div>
    <h2>${escapeHtml(event.title)}</h2>
    <div class="detail-source">${escapeHtml(event.ticker)} · ${escapeHtml(event.sourceName)} · ${escapeHtml(prettyLabel(event.eventType))}</div>
    ${scoreCards}
    ${event.summary ? `<section class="detail-section"><h3>${event.status === "upcoming" ? "Guidance" : "Assessment"}</h3><p>${escapeHtml(event.summary)}</p></section>` : ""}
    ${expectation}
    ${realized}
    ${dateChanged ? `<section class="detail-section"><h3>Schedule revision</h3><p>Initial guidance ${escapeHtml(formatDate(event.initialEventDate))}; current guidance ${escapeHtml(formatDate(event.eventDate))}.</p></section>` : ""}
    ${outcome ? `<div class="calibration-note">Post-event · XBI-adjusted where available · original alert score preserved</div>` : ""}
    ${sourceLink(event.sourceUrl)}
  </div>`;
}

function timelineOutcomeValue(label, value, className) {
  return `<span><small>${escapeHtml(label)}</small><strong class="${escapeHtml(className)}">${escapeHtml(value)}</strong></span>`;
}

function timelineDateParts(event) {
  const date = new Date(event.eventDate);
  if (Number.isNaN(date.getTime())) return { primary: event.dateLabel || "TBD", secondary: "" };
  if (["quarter", "half", "year"].includes(event.datePrecision)) {
    return { primary: event.dateLabel, secondary: event.datePrecision === "year" ? "Guidance" : String(date.getUTCFullYear()) };
  }
  if (event.datePrecision === "month") {
    return {
      primary: new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(date),
      secondary: String(date.getUTCFullYear()),
    };
  }
  return {
    primary: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "America/New_York" }).format(date),
    secondary: String(new Intl.DateTimeFormat(undefined, { year: "numeric", timeZone: "America/New_York" }).format(date)),
  };
}

function scoreValue(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? `${Math.round(Number(value))}/100` : "--";
}

function probability(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? `${Math.round(Number(value) * 100)}%` : "--";
}

function signedPoints(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${Math.round(number)}` : "--";
}

function renderWatchlist() {
  const followedTickers = new Set(state.preferences.watchedTickers);
  const filtered = state.watchlist.filter((company) => {
    if (state.watchlistScope === "followed" && !followedTickers.has(company.ticker)) return false;
    if (state.marketCap !== "all" && company.marketCapBand !== state.marketCap) return false;
    if (!state.watchlistQuery) return true;
    return [company.ticker, company.company, ...(company.aliases || []), ...(company.programs || [])]
      .join(" ")
      .toLowerCase()
      .includes(state.watchlistQuery);
  }).sort((left, right) => Number(followedTickers.has(right.ticker)) - Number(followedTickers.has(left.ticker)));
  elements.watchlistScope.querySelectorAll("[data-watchlist-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.watchlistScope === state.watchlistScope);
  });
  text("#watchlist-total", `${filtered.length} compan${filtered.length === 1 ? "y" : "ies"}`);
  text("#watchlist-followed", `${followedTickers.size}/${state.watchlistLimit} followed`);
  if (!filtered.length) {
    elements.watchlistGrid.innerHTML = emptyState(
      state.watchlist.length ? "No matching companies" : "Watchlist unavailable",
      state.watchlist.length ? "Change the search or market cap filter." : "The monitored universe could not be loaded.",
    );
    return;
  }
  elements.watchlistGrid.innerHTML = filtered.map((company) => {
    const followed = followedTickers.has(company.ticker);
    const coverage = company.coverage || {};
    const coverageLabels = [coverage.companyIr ? "IR" : null, coverage.pressReleases ? "Press" : null,
      coverage.sec ? "SEC" : null, coverage.clinicalTrials ? "Trials" : null].filter(Boolean);
    const programs = (company.programs || []).slice(0, 2).join(" · ");
    return `<article class="company-row">
      <button class="follow-button ${followed ? "followed" : ""}" data-follow-ticker="${escapeHtml(company.ticker)}" type="button" aria-label="${followed ? "Unfollow" : "Follow"} ${escapeHtml(company.ticker)}" data-tooltip="${followed ? "Unfollow" : "Follow"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>
      </button>
      <span class="ticker">${escapeHtml(company.ticker)}</span>
      <span class="company-name"><strong>${escapeHtml(company.company)}</strong><small>${escapeHtml(programs || (company.aliases || []).slice(0, 2).join(" · ") || "Biotechnology")}</small></span>
      <span class="coverage-cell"><strong class="coverage-level ${escapeHtml(coverage.level || "core")}">${escapeHtml(coverage.level || "core")}</strong><small>${escapeHtml(coverageLabels.join(" · ") || "Core monitoring")}</small></span>
      <span class="cap-band">${escapeHtml(company.marketCapBand)}</span>
    </article>`;
  }).join("");
}

function renderSources() {
  if (!state.access?.pro) {
    text("#source-summary", "Pro access");
    elements.sourceList.innerHTML = `<div class="locked-state">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <strong>Source diagnostics are locked</strong>
      <span>Real-time source state is available with Pro or developer access.</span>
      <button class="text-button" data-open-settings type="button">Open access</button>
    </div>`;
    return;
  }
  const sources = state.status?.sources || [];
  const healthy = sources.filter((source) => !source.lastError).length;
  text("#source-summary", `${healthy}/${sources.length} healthy`);
  if (!sources.length) {
    elements.sourceList.innerHTML = emptyState("No source state yet", "A source appears after its first monitor fetch.");
    return;
  }
  elements.sourceList.innerHTML = sources.map((source) => `<article class="source-row">
    <span class="health-state ${source.lastError ? "error" : ""}">${source.lastError ? "Error" : "Healthy"}</span>
    <span class="source-name"><strong>${escapeHtml(prettySource(source.sourceId))}</strong><small>${source.lastError ? escapeHtml(truncate(source.lastError, 120)) : "Official API or publication feed"}</small></span>
    <time class="source-time">${source.lastFetchedAt ? relativeTime(source.lastFetchedAt) : "Never"}</time>
  </article>`).join("");
}

function setTier(tier) {
  state.tier = ["all", "urgent", "high", "watch"].includes(tier) ? tier : "all";
  document.querySelectorAll('input[name="tier"]').forEach((input) => { input.checked = input.value === state.tier; });
  document.querySelectorAll("#mobile-filters [data-tier]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tier === state.tier);
  });
  renderSignals();
}

function switchView(view, updateHash = true) {
  const next = ["signals", "timeline", "watchlist", "sources"].includes(view) ? view : "signals";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === next;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === next);
  });
  if (updateHash) history.replaceState(null, "", `#${next}`);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openSettings() {
  renderAccess();
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
}

function setConnection(kind, label) {
  elements.connection.className = `connection ${kind}`;
  elements.connection.querySelector("strong").textContent = label;
}

function initialView() {
  return ["signals", "timeline", "watchlist", "sources"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "signals";
}

function loadIdentity() {
  try {
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_KEY));
    if (/^[0-9a-f-]{36}$/i.test(parsed.installationId) && /^[0-9a-f]{64}$/i.test(parsed.clientToken)) return parsed;
  } catch {}
  const identity = createIdentity();
  persistIdentity(identity);
  return identity;
}

function createIdentity() {
  return { installationId: randomUuid(), clientToken: randomHex(32) };
}

function persistIdentity(identity) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch {}
}

function randomUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function randomHex(length) {
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      entries: state.entries.slice(0, 80),
      timeline: state.timeline.slice(0, 500),
      timelineSummary: state.timelineSummary,
      watchlist: state.watchlist,
      status: state.status,
      access: state.access,
      freeFeedDelayMinutes: state.freeFeedDelayMinutes,
      preferences: state.preferences,
      watchlistLimit: state.watchlistLimit,
      monitoredUniverse: state.monitoredUniverse,
      lastUpdatedAt: state.lastUpdatedAt,
    }));
  } catch {}
}

function restoreCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (Array.isArray(cached.entries)) state.entries = cached.entries;
    if (Array.isArray(cached.timeline)) state.timeline = cached.timeline;
    if (cached.timelineSummary) state.timelineSummary = cached.timelineSummary;
    if (Array.isArray(cached.watchlist)) state.watchlist = cached.watchlist;
    if (cached.status) state.status = cached.status;
    if (cached.access) state.access = cached.access;
    if (Number.isFinite(cached.freeFeedDelayMinutes)) state.freeFeedDelayMinutes = cached.freeFeedDelayMinutes;
    if (cached.preferences) state.preferences = cached.preferences;
    if (Number.isFinite(cached.watchlistLimit)) state.watchlistLimit = cached.watchlistLimit;
    if (Number.isFinite(cached.monitoredUniverse)) state.monitoredUniverse = cached.monitoredUniverse;
    if (cached.lastUpdatedAt) state.lastUpdatedAt = cached.lastUpdatedAt;
  } catch {}
}

function detailList(title, values) {
  if (!values?.length) return "";
  return `<section class="detail-section"><h3>${escapeHtml(title)}</h3><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul></section>`;
}

function movementInline(movement) {
  if (!movement) return "";
  const label = movement.window === "five_day" ? "5-day" : "since news";
  return `<i></i><span class="day-move ${movementClass(movement.changePct)}">${marketSigned(movement.changePct)} ${label}</span>`;
}

function displayTicker(entry) {
  const assessment = entry.analysis?.assessment;
  if (assessment) return assessment.isBiotechCatalyst ? assessment.ticker || entry.item.tickerHint || "" : "";
  return entry.item.tickerHint || "";
}

function marketMovementPanel(movement) {
  if (!movement) return "";
  const final = movement.window === "five_day";
  const closeLabel = final ? "5-day" : "Latest";
  const startAt = movement.priceStartAt || movement.announcementAt;
  const endAt = movement.priceEndAt || movement.fetchedAt;
  return `<section class="market-movement-panel">
    <header>
      <span><small>${escapeHtml(movementWindowTitle(movement))}</small><strong>${escapeHtml(marketWindowRange(startAt, endAt))}</strong></span>
      <span class="market-movement-change ${movementClass(movement.changePct)}"><small>${final ? "final" : "updating"}</small><strong>${marketSigned(movement.changePct)}</strong></span>
    </header>
    <div class="market-prices">
      ${marketPrice("Before news", movement.previousClose)}
      ${marketPrice("High", movement.high)}
      ${marketPrice("Low", movement.low)}
      ${marketPrice(closeLabel, movement.close)}
    </div>
    <footer>Alpaca · ${escapeHtml(String(movement.feed).toUpperCase())} · Last available trade before announcement</footer>
  </section>`;
}

function movementWindowTitle(movement) {
  return movement.window === "five_day" ? "5-day return" : "Since announcement";
}

function marketWindowRange(startAt, endAt) {
  if (!startAt || !endAt) return "Price window";
  return `${marketTimestamp(startAt)} to ${marketTimestamp(endAt)}`;
}

function marketTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "Unknown");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(date);
}

function marketPrice(label, value) {
  return `<span><small>${escapeHtml(label)}</small><strong>${formatPrice(value)}</strong></span>`;
}

function sourceLink(value) {
  return `<a class="source-link" href="${safeUrl(value)}" target="_blank" rel="noopener noreferrer">Verify primary source<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>`;
}

function emptyState(title, copy) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div>`;
}

function text(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = String(value);
}

function prettyLabel(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

function prettySource(value) {
  return String(value).split("-").map((word) => {
    if (["sec", "fda", "rss"].includes(word)) return word.toUpperCase();
    if (word === "x") return "X";
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function phaseLabel(value) {
  if (!value || value === "unknown") return "Unknown phase";
  if (value === "not_applicable") return "Not applicable";
  if (value === "post_market") return "Post-market";
  if (value === "preclinical") return "Preclinical";
  return value.replace("phase_", "Phase ").replaceAll("_", "/");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function relativeTime(value) {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds)) return "Unknown";
  const seconds = Math.round(milliseconds / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return formatDate(value);
}

function signed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${number.toFixed(0)}%` : "--";
}

function marketSigned(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${number.toFixed(1)}%` : "--";
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `$${number.toFixed(Math.abs(number) < 1 ? 4 : 2)}`;
}

function marketSessionDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value || "Unknown session");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(date);
}

function movementClass(value) {
  const number = Number(value);
  return number > 0 ? "positive" : number < 0 ? "negative" : "flat";
}

function truncate(value, length) {
  const textValue = String(value || "");
  return textValue.length > length ? `${textValue.slice(0, length - 1)}…` : textValue;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.toString()) : "#";
  } catch {
    return "#";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character]));
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3400);
}

initialize().catch(() => {
  setConnection("error", "Unavailable");
  if (!state.entries.length) elements.signalList.innerHTML = emptyState("Monitor unavailable", "The backend could not be reached.");
});
