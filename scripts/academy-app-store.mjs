import { readFile } from "node:fs/promises";
import { sign } from "node:crypto";

// Prepare the academy listing only. App Store Connect handles final review
// submission after screenshots, privacy answers, and review access are ready.
const action = process.argv[2] ?? "inspect";
if (!["validate", "inspect", "configure"].includes(action)) throw new Error("Use validate, inspect, or configure");
const metadata = JSON.parse(await readFile(new URL("../ios/AppStore/academy-en-US.json", import.meta.url)));
for (const [key, limit] of Object.entries({ name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 })) {
  if (typeof metadata[key] !== "string" || !metadata[key].trim() || metadata[key].length > limit) throw new Error(`Invalid ${key}: maximum ${limit} characters`);
}
for (const key of ["marketingUrl", "supportUrl", "privacyPolicyUrl"]) if (new URL(metadata[key]).protocol !== "https:") throw new Error(`${key} must use HTTPS`);
const project = await readFile(new URL("../ios/project.yml", import.meta.url), "utf8");
if (!project.includes(`MARKETING_VERSION: "${metadata.version}"`)) throw new Error("Listing version must match the Xcode project");
if (metadata.appId !== "6803988538" || metadata.locale !== "en-US") throw new Error("Unexpected academy app or locale");
if (action === "validate") {
  console.log(JSON.stringify({ valid: true, app: metadata.name, version: metadata.version, descriptionCharacters: metadata.description.length, keywordsCharacters: metadata.keywords.length }));
  process.exit(0);
}

const required = name => { if (!process.env[name]?.trim()) throw new Error(`Missing ${name}`); return process.env[name].trim(); };
const key = required("ASC_PRIVATE_KEY").replaceAll("\\n", "\n");
const buildNumber = required("ASC_BUILD_NUMBER");
let token, expires = 0;
function authorization() {
  if (token && Date.now() < expires - 60_000) return token;
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: required("ASC_KEY_ID"), typ: "JWT" })}.${encode({ iss: required("ASC_ISSUER_ID"), iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  expires = (now + 600) * 1000;
  return token = `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function api(path, method = "GET", data) {
  const url = new URL(path, "https://api.appstoreconnect.apple.com");
  if (url.origin !== "https://api.appstoreconnect.apple.com") throw new Error("Unexpected Apple API origin");
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${authorization()}`, "Content-Type": "application/json" }, body: data ? JSON.stringify({ data }) : undefined, signal: AbortSignal.timeout(30_000) });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(`${method} ${url.pathname}: ${JSON.stringify(body.errors)}`);
  return body;
}
async function all(path) {
  const rows = [];
  while (path) { const page = await api(path); rows.push(...page.data); path = page.links?.next; }
  return rows;
}
async function patch(type, id, attributes, relationships) {
  return (await api(`/v1/${type}/${id}`, "PATCH", { type, id, ...(attributes ? { attributes } : {}), ...(relationships ? { relationships } : {}) })).data;
}
const app = metadata.appId;
const editable = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const [versions, infos, builds] = await Promise.all([
  all(`/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=200`),
  all(`/v1/apps/${app}/appInfos?limit=200`),
  all(`/v1/builds?${new URLSearchParams({ "filter[app]": app, "filter[version]": buildNumber, "filter[preReleaseVersion.version]": metadata.version, limit: "20" })}`),
]);
let version = versions.find(row => row.attributes.versionString === metadata.version);
let info = infos.find(row => editable.has(row.attributes.state));
const build = builds.find(row => row.attributes.processingState === "VALID" && !row.attributes.expired);
if (action === "configure") {
  if (version && !editable.has(version.attributes.appStoreState)) throw new Error(`Version is locked in ${version.attributes.appStoreState}`);
  if (!version) {
    const drafts = versions.filter(row => editable.has(row.attributes.appStoreState));
    if (drafts.length > 1) throw new Error("Multiple editable iOS versions require review in App Store Connect");
    if (drafts.length === 1) version = await patch("appStoreVersions", drafts[0].id, { versionString: metadata.version, releaseType: "MANUAL", copyright: metadata.copyright });
    else version = (await api("/v1/appStoreVersions", "POST", { type: "appStoreVersions", attributes: { platform: "IOS", versionString: metadata.version, releaseType: "MANUAL", copyright: metadata.copyright }, relationships: { app: { data: { type: "apps", id: app } } } })).data;
  }
  if (!info) info = (await all(`/v1/apps/${app}/appInfos?limit=200`)).find(row => editable.has(row.attributes.state));
  if (!info) throw new Error("No editable app information; inspect App Store Connect");
  await patch("appStoreVersions", version.id, { releaseType: "MANUAL", copyright: metadata.copyright });
  await patch("appInfos", info.id, undefined, { primaryCategory: { data: { type: "appCategories", id: metadata.primaryCategory } }, secondaryCategory: { data: { type: "appCategories", id: metadata.secondaryCategory } } });
  async function localization(parentType, parentID, type, attributes) {
    const current = (await all(`/v1/${parentType}/${parentID}/${type}?limit=200`)).find(row => row.attributes.locale === metadata.locale);
    if (current) return patch(type, current.id, attributes);
    return (await api(`/v1/${type}`, "POST", { type, attributes: { locale: metadata.locale, ...attributes }, relationships: { [parentType === "appInfos" ? "appInfo" : "appStoreVersion"]: { data: { type: parentType, id: parentID } } } })).data;
  }
  await localization("appInfos", info.id, "appInfoLocalizations", { name: metadata.name, subtitle: metadata.subtitle, privacyPolicyUrl: metadata.privacyPolicyUrl });
  const attributes = Object.fromEntries(["description", "keywords", "marketingUrl", "supportUrl", "promotionalText"].map(key => [key, metadata[key]]));
  if (versions.some(row => ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE"].includes(row.attributes.appStoreState))) attributes.whatsNew = metadata.whatsNew;
  await localization("appStoreVersions", version.id, "appStoreVersionLocalizations", attributes);
  if (build) await api(`/v1/appStoreVersions/${version.id}/relationships/build`, "PATCH", { type: "builds", id: build.id });
}
const localizations = version ? await all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`) : [];
const screenshotSets = [];
for (const locale of localizations) for (const set of await all(`/v1/appStoreVersionLocalizations/${locale.id}/appScreenshotSets?limit=200`)) {
  const shots = await all(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`);
  screenshotSets.push({ locale: locale.attributes.locale, displayType: set.attributes.screenshotDisplayType, files: shots.map(row => ({ name: row.attributes.fileName, state: row.attributes.assetDeliveryState?.state })) });
}
console.log(JSON.stringify({
  action, app, requestedVersion: metadata.version, requestedBuild: buildNumber,
  versions: versions.map(row => ({ id: row.id, version: row.attributes.versionString, state: row.attributes.appStoreState })),
  selectedVersion: version ? { id: version.id, version: version.attributes.versionString, state: version.attributes.appStoreState } : null,
  validBuild: build ? { id: build.id, number: build.attributes.version } : null,
  screenshotSets,
  remainingReview: [
    ...(!build ? ["Upload and process the requested academy build"] : []),
    "Visually verify academy screenshots and replace obsolete stock-app images",
    "Update age rating and App Privacy answers for the academy app",
    "Verify support/privacy URLs, pricing, distribution, review contact details, and existing subscription status",
    "Provide complete reviewer access or physical-device demonstrations for location and optional NFC features",
    "Submit the completed version through App Store Connect",
  ],
  submitted: false,
}, null, 2));
