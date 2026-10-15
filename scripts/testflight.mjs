import { sign } from "node:crypto";

const action = process.env.ASC_TESTFLIGHT_ACTION ?? "inspect";
if (!["inspect", "prepare", "notify"].includes(action)) throw new Error("Unknown TestFlight action");
const appId = required("ASC_APP_ID");
const version = required("ASC_APP_VERSION");
const buildNumber = required("ASC_BUILD_NUMBER");
const groupIds = [...new Set((process.env.ASC_TESTFLIGHT_GROUP_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean))];
const notes = process.env.ASC_TESTFLIGHT_NOTES?.trim();
if (action === "prepare" && (!groupIds.length || !notes || notes.length > 4000)) {
  throw new Error("Prepare requires existing group IDs and 1–4000 characters of test notes");
}

const key = required("ASC_PRIVATE_KEY").replaceAll("\\n", "\n");
let token;
let expiresAt = 0;
const params = new URLSearchParams({ "filter[app]": appId, "filter[version]": buildNumber,
  "filter[preReleaseVersion.version]": version, sort: "-uploadedDate", limit: "20" });
let build;
for (let attempt = 0; attempt < (action === "inspect" ? 1 : 60); attempt++) {
  build = (await all(`/v1/builds?${params}`))[0];
  if (action === "inspect" || build?.attributes.processingState === "VALID") break;
  if (["FAILED", "INVALID"].includes(build?.attributes.processingState)) {
    throw new Error(`Apple processing failed: ${build.attributes.processingState}`);
  }
  console.log(`Waiting for build ${version} (${buildNumber}) to finish processing`);
  await new Promise(resolve => setTimeout(resolve, 15_000));
}
if (!build) throw new Error(`Build ${version} (${buildNumber}) was not found`);
if (action !== "inspect" && (build.attributes.processingState !== "VALID" || build.attributes.expired)) {
  throw new Error("The selected build is not valid and unexpired");
}

if (action === "prepare") await prepare();
if (action === "notify") {
  const detail = (await api(`/v1/builds/${build.id}/buildBetaDetail`)).data;
  if (detail.attributes.externalBuildState !== "IN_BETA_TESTING") {
    if (!["READY_FOR_BETA_TESTING", "BETA_APPROVED"].includes(detail.attributes.externalBuildState)) {
      throw new Error(`Build is not ready for distribution: ${detail.attributes.externalBuildState}`);
    }
    // This explicitly dispatched action sends Apple's TestFlight notification.
    await api("/v1/buildBetaNotifications", { method: "POST", body: {
      data: { type: "buildBetaNotifications", relationships: { build: { data: { type: "builds", id: build.id } } } },
    } });
  }
}
await report();

async function prepare() {
  if (build.attributes.buildAudienceType === "INTERNAL_ONLY") throw new Error("Build only supports internal testing");
  const groups = await all(`/v1/apps/${appId}/betaGroups?limit=200`);
  const selected = groupIds.map(id => groups.find(group => group.id === id));
  if (selected.some(group => !group || group.attributes.isInternalGroup)) {
    throw new Error("Every selected group must be an existing external group for this app");
  }
  const detail = (await api(`/v1/builds/${build.id}/buildBetaDetail`)).data;
  // Preparing review must not send notifications; release is a separate action.
  if (detail.attributes.autoNotifyEnabled && detail.attributes.externalBuildState !== "IN_BETA_TESTING") {
    await api(`/v1/buildBetaDetails/${detail.id}`, { method: "PATCH", body: {
      data: { type: "buildBetaDetails", id: detail.id, attributes: { autoNotifyEnabled: false } },
    } });
  }
  const localizations = await all(`/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
  const localization = localizations.find(item => item.attributes.locale === "en-US");
  if (localization) {
    await api(`/v1/betaBuildLocalizations/${localization.id}`, { method: "PATCH", body: {
      data: { type: "betaBuildLocalizations", id: localization.id, attributes: { whatsNew: notes } },
    } });
  } else {
    await api("/v1/betaBuildLocalizations", { method: "POST", body: { data: {
      type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew: notes },
      relationships: { build: { data: { type: "builds", id: build.id } } },
    } } });
  }
  const currentGroups = await all(`/v1/builds/${build.id}/betaGroups?limit=200`);
  const missing = groupIds.filter(id => !currentGroups.some(group => group.id === id));
  if (missing.length) {
    await api(`/v1/builds/${build.id}/relationships/betaGroups`, { method: "POST", body: {
      data: missing.map(id => ({ type: "betaGroups", id })),
    } });
  }
  const updatedDetail = (await api(`/v1/builds/${build.id}/buildBetaDetail`)).data;
  if (updatedDetail.attributes.externalBuildState === "READY_FOR_BETA_SUBMISSION") {
    await api("/v1/betaAppReviewSubmissions", { method: "POST", body: {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
    } });
  }
}

async function report() {
  const [detail, groups, localizations] = await Promise.all([
    api(`/v1/builds/${build.id}/buildBetaDetail`),
    all(`/v1/builds/${build.id}/betaGroups?limit=200`),
    all(`/v1/builds/${build.id}/betaBuildLocalizations?limit=200`),
  ]);
  console.log(JSON.stringify({ build: { id: build.id, version, buildNumber,
    processingState: build.attributes.processingState, expired: build.attributes.expired },
    beta: detail.data.attributes,
    groups: groups.map(group => ({ id: group.id, name: group.attributes.name, isInternalGroup: group.attributes.isInternalGroup })),
    notes: localizations.map(item => ({ locale: item.attributes.locale, whatsNew: item.attributes.whatsNew })),
  }, null, 2));
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function authorizationToken() {
  const now = Math.floor(Date.now() / 1000);
  if (token && now < expiresAt - 60) return token;
  expiresAt = now + 600;
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", kid: required("ASC_KEY_ID"), typ: "JWT" })}.${encode({
    iss: required("ASC_ISSUER_ID"), iat: now, exp: expiresAt, aud: "appstoreconnect-v1",
  })}`;
  token = `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  return token;
}

async function api(path, options = {}) {
  const url = new URL(path, "https://api.appstoreconnect.apple.com");
  if (url.origin !== "https://api.appstoreconnect.apple.com") throw new Error("Unexpected API origin");
  const response = await fetch(url, { method: options.method ?? "GET", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${authorizationToken()}`, Accept: "application/json", "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url.pathname}: ${JSON.stringify(payload.errors)}`);
  return payload;
}

async function all(path) {
  const data = [];
  while (path) {
    const page = await api(path);
    data.push(...page.data);
    path = page.links?.next;
  }
  return data;
}
