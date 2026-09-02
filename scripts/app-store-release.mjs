import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { importPKCS8, SignJWT } from "jose";

const API_BASE = "https://api.appstoreconnect.apple.com";
const PRIVACY_POLICY_URL = "https://lackadaisical-a.github.io/monitor/privacy.html";
const TERMS_OF_USE_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const REVIEW_NOTE_MARKER = "Guideline 3.1.2 response (September 2, 2026)";
const REVIEW_NOTE = `${REVIEW_NOTE_MARKER}:
The App Store description now includes functional Privacy Policy and Terms of Use (EULA) links. In the app, open Settings > Upgrade to Pro. The paywall shows the monthly and annual subscription titles, their App Store prices, Restore Purchases, the auto-renewal and cancellation terms, and functional Terms of Use and Privacy Policy links. No account is required.`;
const EU_TERRITORIES = new Set([
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN",
  "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX",
  "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
]);
const AGE_RATING_ATTRIBUTES = {
  advertising: false,
  alcoholTobaccoOrDrugUseOrReferences: "NONE",
  contests: "NONE",
  gambling: false,
  gamblingSimulated: "NONE",
  gunsOrOtherWeapons: "NONE",
  healthOrWellnessTopics: true,
  horrorOrFearThemes: "NONE",
  lootBox: false,
  matureOrSuggestiveThemes: "NONE",
  medicalOrTreatmentInformation: "FREQUENT",
  messagingAndChat: false,
  parentalControls: false,
  profanityOrCrudeHumor: "NONE",
  ageAssurance: false,
  sexualContentGraphicAndNudity: "NONE",
  sexualContentOrNudity: "NONE",
  socialMedia: false,
  socialMediaAgeRestricted: false,
  unrestrictedWebAccess: false,
  userGeneratedContent: false,
  violenceCartoonOrFantasy: "NONE",
  violenceRealistic: "NONE",
  violenceRealisticProlongedGraphicOrSadistic: "NONE",
  ageRatingOverrideV2: "NONE",
  koreaAgeRatingOverride: "NONE",
};
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
const appInfo = await getAppInfo();
const build = action === "inspect" ? await findBuild() : await waitForBuild();
const { group, subscriptions } = await getSubscriptions();

if (action !== "inspect") {
  await configureAppMetadata(appVersion, appInfo);
  await assignBuild(appVersion.id, build.id);
  for (const subscription of subscriptions) {
    await enforceSubscriptionAvailability(subscription);
    await ensureReviewScreenshot(subscription);
  }
}

const report = await inspectRelease(appVersion, appInfo, build, group, subscriptions);
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
    const details = payload?.errors?.map((error) => {
      const context = [error.source, error.meta]
        .filter(Boolean)
        .map((value) => JSON.stringify(value))
        .join(" ");
      return `${error.code ?? response.status}: ${error.detail ?? error.title}${context ? ` (${context})` : ""}`;
    }).join("; ")
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

async function getAppInfo() {
  const infos = await all(`/v1/apps/${config.appId}/appInfos?limit=200`);
  const current = infos.find((info) => !["REPLACED_WITH_NEW_INFO", "ACCEPTED"].includes(info.attributes?.state))
    ?? infos[0];
  if (!current) throw new Error("App information was not found");
  return current;
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

async function configureAppMetadata(version, info) {
  await api(`/v1/apps/${config.appId}`, {
    method: "PATCH",
    body: {
      data: {
        type: "apps",
        id: config.appId,
        attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" },
      },
    },
  });

  const ageRating = (await api(`/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;
  await api(`/v1/ageRatingDeclarations/${ageRating.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "ageRatingDeclarations",
        id: ageRating.id,
        attributes: AGE_RATING_ATTRIBUTES,
      },
    },
  });

  const localizations = await all(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`);
  if (!localizations.length) throw new Error("App information localization was not found");
  for (const localization of localizations) {
    await api(`/v1/appInfoLocalizations/${localization.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appInfoLocalizations",
          id: localization.id,
          attributes: { privacyPolicyUrl: PRIVACY_POLICY_URL },
        },
      },
    });
  }

  await ensureAppVersionLegalMetadata(version);
  await ensureAppReviewNotes(version);

  await ensureFreeAppPrice();
}

async function ensureAppVersionLegalMetadata(version) {
  const localizations = await all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  if (!localizations.length) throw new Error("App Store version localization was not found");
  for (const localization of localizations) {
    const current = localization.attributes?.description?.trim() ?? "";
    const additions = [
      current.includes(PRIVACY_POLICY_URL) ? null : `Privacy Policy: ${PRIVACY_POLICY_URL}`,
      current.includes(TERMS_OF_USE_URL) ? null : `Terms of Use (EULA): ${TERMS_OF_USE_URL}`,
    ].filter(Boolean);
    if (!additions.length) continue;
    const description = [current, additions.join("\n")].filter(Boolean).join("\n\n");
    if (description.length > 4_000) {
      throw new Error(`App Store description for ${localization.attributes?.locale ?? localization.id} cannot fit required legal links`);
    }
    await api(`/v1/appStoreVersionLocalizations/${localization.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appStoreVersionLocalizations",
          id: localization.id,
          attributes: { description },
        },
      },
    });
  }
}

async function ensureAppReviewNotes(version) {
  const detail = (await optional(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`))?.data ?? null;
  if (!detail) {
    console.warn("App Review detail was not found; skipping the Guideline 3.1.2 reviewer note");
    return;
  }
  const current = detail.attributes?.notes?.trim() ?? "";
  if (current.includes(REVIEW_NOTE_MARKER)) return;
  const notes = [current, REVIEW_NOTE].filter(Boolean).join("\n\n");
  if (notes.length > 4_000) {
    console.warn("App Review notes are too long to append the Guideline 3.1.2 response; existing notes were preserved");
    return;
  }
  await api(`/v1/appStoreReviewDetails/${detail.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "appStoreReviewDetails",
        id: detail.id,
        attributes: { notes },
      },
    },
  });
}

async function ensureFreeAppPrice() {
  const existing = await getAppPriceScheduleReport();
  if (existing?.manualPrices.some((price) => Number(price.customerPrice) === 0 && !price.endDate)) return;

  const params = new URLSearchParams({
    "filter[territory]": "USA",
    "fields[appPricePoints]": "customerPrice",
    limit: "200",
  });
  const pricePoints = await all(`/v1/apps/${config.appId}/appPricePoints?${params}`);
  const freePricePoint = pricePoints.find((point) => Number(point.attributes?.customerPrice) === 0);
  if (!freePricePoint) throw new Error("The free USA app price point was not found");

  const inlinePriceId = "${p1}";
  await api("/v1/appPriceSchedules", {
    method: "POST",
    body: {
      data: {
        type: "appPriceSchedules",
        relationships: {
          app: { data: { type: "apps", id: config.appId } },
          manualPrices: { data: [{ type: "appPrices", id: inlinePriceId }] },
          baseTerritory: { data: { type: "territories", id: "USA" } },
        },
      },
      included: [{
        type: "appPrices",
        id: inlinePriceId,
        attributes: { startDate: null },
        relationships: {
          appPricePoint: { data: { type: "appPricePoints", id: freePricePoint.id } },
        },
      }],
    },
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await getAppPriceScheduleReport();
    if (current?.manualPrices.some((price) => Number(price.customerPrice) === 0 && !price.endDate)) return;
    await sleep(3_000);
  }
  throw new Error("Apple accepted the free price request but did not create an active manual price");
}

async function getAppPriceScheduleReport() {
  const schedule = (await optional(`/v1/apps/${config.appId}/appPriceSchedule`))?.data ?? null;
  if (!schedule) return null;

  const priceParams = new URLSearchParams({
    include: "appPricePoint,territory",
    "fields[appPricePoints]": "customerPrice",
    "fields[territories]": "currency",
    limit: "200",
  });
  const manualPage = await api(`/v1/appPriceSchedules/${schedule.id}/manualPrices?${priceParams}`);
  const includedById = new Map((manualPage.included ?? []).map((item) => [item.id, item]));
  const automaticPrices = await all(`/v1/appPriceSchedules/${schedule.id}/automaticPrices?limit=200`);
  const baseTerritory = (await optional(`/v1/appPriceSchedules/${schedule.id}/baseTerritory`))?.data ?? null;
  return {
    id: schedule.id,
    baseTerritory: baseTerritory?.id ?? null,
    manualPrices: (manualPage.data ?? []).map((price) => {
      const pointId = price.relationships?.appPricePoint?.data?.id ?? null;
      return {
        id: price.id,
        ...price.attributes,
        territory: price.relationships?.territory?.data?.id ?? null,
        customerPrice: includedById.get(pointId)?.attributes?.customerPrice ?? null,
      };
    }),
    automaticPriceCount: automaticPrices.length,
  };
}

async function inspectAppCommerce() {
  const priceSchedule = await getAppPriceScheduleReport();

  const availability = (await optional(`/v1/apps/${config.appId}/appAvailabilityV2`))?.data ?? null;
  const territoryAvailabilities = availability
    ? await all(`/v2/appAvailabilities/${availability.id}/territoryAvailabilities?limit=200`)
    : [];
  const availableTerritories = territoryAvailabilities.filter((item) => item.attributes?.available);
  return {
    priceSchedule,
    availability: availability ? {
      id: availability.id,
      availableInNewTerritories: availability.attributes?.availableInNewTerritories,
      availableTerritoryCount: availableTerritories.length,
      euTerritoryCount: availableTerritories.filter((item) => EU_TERRITORIES.has(
        item.relationships?.territory?.data?.id,
      )).length,
    } : null,
  };
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
  const bytes = await readFile(config.screenshotPath);
  const checksum = createHash("md5").update(bytes).digest("hex");
  const state = screenshot?.attributes?.assetDeliveryState?.state;
  const matchesCurrentFile = screenshot?.attributes?.sourceFileChecksum === checksum
    || (
      screenshot?.attributes?.fileName === basename(config.screenshotPath)
      && Number(screenshot?.attributes?.fileSize) === bytes.length
  );
  if (state === "COMPLETE" && matchesCurrentFile) return;
  if (screenshot) {
    try {
      await api(`/v1/subscriptionAppStoreReviewScreenshots/${screenshot.id}`, { method: "DELETE" });
    } catch (error) {
      if (error.status === 409 && error.message.includes("MEDIA_ASSET_DELETE_NOT_ALLOWED")) {
        console.warn(`Apple has locked the accepted review screenshot for ${subscription.attributes.productId}; preserving it`);
        return;
      }
      throw error;
    }
  }

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
        attributes: { uploaded: true, sourceFileChecksum: checksum },
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

async function inspectRelease(version, info, build, group, subscriptions) {
  const assignedBuild = (await optional(`/v1/appStoreVersions/${version.id}/build`))?.data ?? null;
  const reviewDetail = (await optional(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`))?.data ?? null;
  const app = (await api(`/v1/apps/${config.appId}?fields[apps]=name,bundleId,contentRightsDeclaration`)).data;
  const ageRating = (await api(`/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;
  const infoLocalizations = await all(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`);
  const versionLocalizations = await all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  const commerce = await inspectAppCommerce();
  const testFlight = await inspectTestFlight(build);
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
    app: { id: app.id, ...app.attributes },
    appInfo: { id: info.id, ...info.attributes },
    ageRating: { id: ageRating.id, ...ageRating.attributes },
    appInfoLocalizations: infoLocalizations.map((localization) => ({ id: localization.id, ...localization.attributes })),
    appStoreVersionLocalizations: versionLocalizations.map((localization) => ({
      id: localization.id,
      locale: localization.attributes?.locale,
      descriptionLength: localization.attributes?.description?.length ?? 0,
      hasPrivacyPolicyLink: localization.attributes?.description?.includes(PRIVACY_POLICY_URL) ?? false,
      hasTermsOfUseLink: localization.attributes?.description?.includes(TERMS_OF_USE_URL) ?? false,
    })),
    appReviewDetail: reviewDetail ? {
      id: reviewDetail.id,
      notesLength: reviewDetail.attributes?.notes?.length ?? 0,
      hasSubscriptionComplianceNote: reviewDetail.attributes?.notes?.includes(REVIEW_NOTE_MARKER) ?? false,
    } : null,
    appCommerce: commerce,
    testFlight,
    appVersion: { id: version.id, ...version.attributes },
    build: build ? { id: build.id, ...build.attributes } : null,
    assignedBuild: assignedBuild ? { id: assignedBuild.id, ...assignedBuild.attributes } : null,
    subscriptionGroup: { id: group.id, ...group.attributes },
    subscriptions: subscriptionReports,
    activeSubmissions,
  };
}

async function inspectTestFlight(build) {
  if (!build) return { buildId: null, buildBetaDetail: null, betaReviewSubmission: null, groups: [] };

  const [detail, betaReviewSubmission, groups] = await Promise.all([
    optional(`/v1/builds/${build.id}/buildBetaDetail`),
    optional(`/v1/builds/${build.id}/betaAppReviewSubmission`),
    all(`/v1/apps/${config.appId}/betaGroups?limit=200`),
  ]);
  const groupReports = [];
  for (const group of groups) {
    const [builds, testers] = await Promise.all([
      all(`/v1/betaGroups/${group.id}/builds?limit=200`),
      all(`/v1/betaGroups/${group.id}/betaTesters?limit=200`),
    ]);
    groupReports.push({
      id: group.id,
      name: group.attributes?.name,
      isInternalGroup: group.attributes?.isInternalGroup,
      hasAccessToAllBuilds: group.attributes?.hasAccessToAllBuilds,
      publicLinkEnabled: group.attributes?.publicLinkEnabled,
      testerCount: testers.length,
      includesBuild: builds.some((candidate) => candidate.id === build.id),
    });
  }
  return {
    buildId: build.id,
    buildBetaDetail: detail?.data ? { id: detail.data.id, ...detail.data.attributes } : null,
    betaReviewSubmission: betaReviewSubmission?.data
      ? { id: betaReviewSubmission.data.id, ...betaReviewSubmission.data.attributes }
      : null,
    groups: groupReports,
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
