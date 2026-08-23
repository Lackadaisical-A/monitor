import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { importPKCS8, SignJWT } from "jose";

const API_BASE = "https://api.appstoreconnect.apple.com";
const EU_TERRITORIES = new Set([
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN",
  "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX",
  "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
]);

const action = process.argv[2] ?? "inspect";
if (!["inspect", "configure", "submit"].includes(action)) {
  throw new Error("Usage: node scripts/app-store-release.mjs inspect|configure|submit");
}

const config = {
  appId: required("ASC_APP_ID"),
  version: process.env.ASC_APP_VERSION ?? "1.0",
  buildNumber: required("ASC_BUILD_NUMBER"),
  productIds: required("ASC_PRODUCT_IDS").split(",").map((value) => value.trim()).filter(Boolean),
  screenshotPath: resolve(process.env.ASC_REVIEW_SCREENSHOT ?? "ios/AppStore/Screenshots/catalyst-watch-paywall-6.5.png"),
};

const privateKey = await importPKCS8(required("ASC_PRIVATE_KEY").replaceAll("\\n", "\n"), "ES256");
let token = "";
let tokenExpiresAt = 0;

const appVersion = await getAppVersion();
const build = action === "inspect" ? await findBuild() : await waitForBuild();
const { group, subscriptions } = await getSubscriptions();

if (action !== "inspect") {
  await assignBuild(appVersion.id, build.id);
  for (const subscription of subscriptions) {
    await enforceSubscriptionAvailability(subscription);
    await ensureReviewScreenshot(subscription);
  }
}

const report = await inspectRelease(appVersion, build, group, subscriptions);
console.log(JSON.stringify(report, null, 2));

if (action === "submit") {
  await submitForReview(appVersion, group, subscriptions);
  console.log(JSON.stringify({ submitted: true, appVersionId: appVersion.id, buildId: build.id }, null, 2));
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function authorizationToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  tokenExpiresAt = Date.now() + 10 * 60_000;
  token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: required("ASC_KEY_ID"), typ: "JWT" })
    .setIssuer(required("ASC_ISSUER_ID"))
    .setAudience("appstoreconnect-v1")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  return token;
}

async function api(path, options = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${await authorizationToken()}`,
    Accept: "application/json",
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const details = payload?.errors?.map((error) => `${error.code ?? response.status}: ${error.detail ?? error.title}`).join("; ")
      ?? `${response.status} ${response.statusText}`;
    const error = new Error(`${options.method ?? "GET"} ${new URL(url).pathname} failed: ${details}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function optional(path) {
  try {
    return await api(path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function all(path) {
  const data = [];
  let next = path;
  while (next) {
    const page = await api(next);
    data.push(...(page.data ?? []));
    next = page.links?.next ?? null;
  }
  return data;
}

async function getAppVersion() {
  const params = new URLSearchParams({
    "filter[platform]": "IOS",
    "filter[versionString]": config.version,
    limit: "20",
  });
  const versions = await all(`/v1/apps/${config.appId}/appStoreVersions?${params}`);
  const version = versions.find((candidate) => candidate.attributes?.versionString === config.version);
  if (!version) throw new Error(`App Store version ${config.version} was not found`);
  return version;
}

async function findBuild() {
  const params = new URLSearchParams({
    "filter[app]": config.appId,
    "filter[version]": config.buildNumber,
    sort: "-uploadedDate",
    limit: "20",
  });
  return (await all(`/v1/builds?${params}`))[0] ?? null;
}

async function waitForBuild() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const build = await findBuild();
    if (build?.attributes?.processingState === "VALID") return build;
    if (["FAILED", "INVALID"].includes(build?.attributes?.processingState)) {
      throw new Error(`Build ${config.buildNumber} processing ended as ${build.attributes.processingState}`);
    }
    await sleep(15_000);
  }
  throw new Error(`Build ${config.buildNumber} did not finish processing within 15 minutes`);
}

async function getSubscriptions() {
  const groups = await all(`/v1/apps/${config.appId}/subscriptionGroups?limit=200`);
  for (const group of groups) {
    const subscriptions = await all(`/v1/subscriptionGroups/${group.id}/subscriptions?limit=200`);
    const selected = subscriptions.filter((subscription) => config.productIds.includes(subscription.attributes?.productId));
    if (selected.length === config.productIds.length) return { group, subscriptions: selected };
  }
  throw new Error(`Could not find all subscription products: ${config.productIds.join(", ")}`);
}

async function assignBuild(versionId, buildId) {
  await api(`/v1/appStoreVersions/${versionId}/relationships/build`, {
    method: "PATCH",
    body: { data: { type: "builds", id: buildId } },
  });
}

async function nonEuTerritories() {
  const territories = await all("/v1/territories?limit=200");
  const selected = territories.filter((territory) => !EU_TERRITORIES.has(territory.id));
  if (territories.length !== 175 || selected.length !== 148) {
    throw new Error(`Unexpected App Store territory count: ${territories.length} total, ${selected.length} non-EU`);
  }
  return selected.map(({ id }) => ({ type: "territories", id }));
}

async function enforceSubscriptionAvailability(subscription) {
  const territoryLinks = await nonEuTerritories();
  const plans = await all(`/v1/subscriptions/${subscription.id}/planAvailabilities?limit=200`);
  if (!plans.length) throw new Error(`No plan availability exists for ${subscription.attributes.productId}`);
  for (const plan of plans) {
    await api(`/v1/subscriptionPlanAvailabilities/${plan.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "subscriptionPlanAvailabilities",
          id: plan.id,
          attributes: { availableInNewTerritories: false },
          relationships: { availableTerritories: { data: territoryLinks } },
        },
      },
    });
  }
}

async function ensureReviewScreenshot(subscription) {
  const relationshipPath = `/v1/subscriptions/${subscription.id}/appStoreReviewScreenshot`;
  let screenshot = (await optional(relationshipPath))?.data ?? null;
  const state = screenshot?.attributes?.assetDeliveryState?.state;
  if (state === "COMPLETE") return;
  if (screenshot) {
    await api(`/v1/subscriptionAppStoreReviewScreenshots/${screenshot.id}`, { method: "DELETE" });
  }

  const bytes = await readFile(config.screenshotPath);
  const reservation = await api("/v1/subscriptionAppStoreReviewScreenshots", {
    method: "POST",
    body: {
      data: {
        type: "subscriptionAppStoreReviewScreenshots",
        attributes: { fileName: basename(config.screenshotPath), fileSize: bytes.length },
        relationships: { subscription: { data: { type: "subscriptions", id: subscription.id } } },
      },
    },
  });
  screenshot = reservation.data;
  for (const operation of screenshot.attributes.uploadOperations ?? []) {
    const headers = Object.fromEntries((operation.requestHeaders ?? []).map(({ name, value }) => [name, value]));
    const upload = await fetch(operation.url, {
      method: operation.method,
      headers,
      body: bytes.subarray(operation.offset, operation.offset + operation.length),
    });
    if (!upload.ok) throw new Error(`Screenshot upload failed with HTTP ${upload.status}`);
  }
  await api(`/v1/subscriptionAppStoreReviewScreenshots/${screenshot.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "subscriptionAppStoreReviewScreenshots",
        id: screenshot.id,
        attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") },
      },
    },
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = (await api(`/v1/subscriptionAppStoreReviewScreenshots/${screenshot.id}`)).data;
    const deliveryState = current.attributes?.assetDeliveryState?.state;
    if (deliveryState === "COMPLETE") return;
    if (deliveryState === "FAILED") {
      throw new Error(`Apple rejected the review screenshot for ${subscription.attributes.productId}`);
    }
    await sleep(3_000);
  }
  throw new Error(`Review screenshot processing timed out for ${subscription.attributes.productId}`);
}

async function inspectRelease(version, build, group, subscriptions) {
  const assignedBuild = (await optional(`/v1/appStoreVersions/${version.id}/build`))?.data ?? null;
  const subscriptionReports = [];
  for (const subscription of subscriptions) {
    const current = (await api(`/v1/subscriptions/${subscription.id}`)).data;
    const plans = await all(`/v1/subscriptions/${subscription.id}/planAvailabilities?limit=200`);
    const planReports = [];
    for (const plan of plans) {
      const territories = await all(`/v1/subscriptionPlanAvailabilities/${plan.id}/relationships/availableTerritories?limit=200`);
      planReports.push({
        id: plan.id,
        type: plan.attributes?.planType,
        availableInNewTerritories: plan.attributes?.availableInNewTerritories,
        territoryCount: territories.length,
        euTerritoryCount: territories.filter(({ id }) => EU_TERRITORIES.has(id)).length,
      });
    }
    const screenshot = (await optional(`/v1/subscriptions/${subscription.id}/appStoreReviewScreenshot`))?.data ?? null;
    const prices = await all(`/v1/subscriptions/${subscription.id}/prices?limit=200`);
    const versions = await all(`/v1/subscriptions/${subscription.id}/versions?limit=200`);
    subscriptionReports.push({
      id: subscription.id,
      productId: current.attributes?.productId,
      state: current.attributes?.state,
      priceCount: prices.length,
      screenshotState: screenshot?.attributes?.assetDeliveryState?.state ?? "MISSING",
      plans: planReports,
      versions: versions.map((item) => ({ id: item.id, ...item.attributes })),
    });
  }
  const submissions = await all(`/v1/apps/${config.appId}/reviewSubmissions?limit=200`);
  const activeSubmissions = [];
  for (const submission of submissions.filter((item) => item.attributes?.state !== "COMPLETE")) {
    const items = await all(reviewItemsPath(submission.id));
    activeSubmissions.push({
      id: submission.id,
      state: submission.attributes?.state,
      items: items.map((item) => ({ id: item.id, state: item.attributes?.state, relationships: item.relationships })),
    });
  }
  return {
    appVersion: { id: version.id, ...version.attributes },
    build: build ? { id: build.id, ...build.attributes } : null,
    assignedBuild: assignedBuild ? { id: assignedBuild.id, ...assignedBuild.attributes } : null,
    subscriptionGroup: { id: group.id, ...group.attributes },
    subscriptions: subscriptionReports,
    activeSubmissions,
  };
}

async function submitForReview(version, group, subscriptions) {
  const currentSubscriptions = await Promise.all(subscriptions.map(async (subscription) => (
    (await api(`/v1/subscriptions/${subscription.id}`)).data
  )));
  const unready = currentSubscriptions.filter((subscription) => subscription.attributes?.state !== "READY_TO_SUBMIT");
  if (unready.length) {
    throw new Error(`Subscriptions not ready: ${unready.map((item) => `${item.attributes.productId}=${item.attributes.state}`).join(", ")}`);
  }

  const reviewSubmissions = await all(`/v1/apps/${config.appId}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&filter[platform]=IOS&limit=200`);
  const submission = reviewSubmissions[0] ?? (await api("/v1/reviewSubmissions", {
    method: "POST",
    body: {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: config.appId } } },
      },
    },
  })).data;

  const targets = [{ relationship: "appStoreVersion", type: "appStoreVersions", id: version.id }];
  const groupVersions = await all(`/v1/subscriptionGroups/${group.id}/versions?limit=200`);
  targets.push({ relationship: "subscriptionGroupVersion", type: "subscriptionGroupVersions", id: latestVersion(groupVersions).id });
  for (const subscription of subscriptions) {
    const versions = await all(`/v1/subscriptions/${subscription.id}/versions?limit=200`);
    targets.push({ relationship: "subscriptionVersion", type: "subscriptionVersions", id: latestVersion(versions).id });
  }

  const existingItems = await all(reviewItemsPath(submission.id));
  const existingTargetIds = new Set(existingItems.flatMap((item) => (
    Object.values(item.relationships ?? {}).map((relationship) => relationship?.data?.id).filter(Boolean)
  )));
  for (const target of targets) {
    if (existingTargetIds.has(target.id)) continue;
    try {
      await api("/v1/reviewSubmissionItems", {
        method: "POST",
        body: {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
              [target.relationship]: { data: { type: target.type, id: target.id } },
            },
          },
        },
      });
    } catch (error) {
      throw new Error(`Could not add ${target.relationship} ${target.id}: ${error.message}`, { cause: error });
    }
  }

  const items = await all(reviewItemsPath(submission.id));
  const blocked = items.filter((item) => item.attributes?.state !== "READY_FOR_REVIEW");
  if (blocked.length) throw new Error(`Review items are not ready: ${blocked.map((item) => `${item.id}=${item.attributes?.state}`).join(", ")}`);
  await api(`/v1/reviewSubmissions/${submission.id}`, {
    method: "PATCH",
    body: { data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } } },
  });
}

function reviewItemsPath(submissionId) {
  const params = new URLSearchParams({
    "fields[reviewSubmissionItems]": "state,appStoreVersion,subscriptionVersion,subscriptionGroupVersion",
    include: "appStoreVersion,subscriptionVersion,subscriptionGroupVersion",
    limit: "200",
  });
  return `/v1/reviewSubmissions/${submissionId}/items?${params}`;
}

function latestVersion(versions) {
  const version = [...versions].sort((left, right) => (right.attributes?.version ?? 0) - (left.attributes?.version ?? 0))[0];
  if (!version) throw new Error("A reviewable subscription metadata version was not found");
  return version;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
