import { X509Certificate } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";

const API_BASE = "https://api.appstoreconnect.apple.com";
const bundleIdentifier = required("ASC_BUNDLE_ID");
const profileName = required("ASC_PROFILE_NAME");
const profilePath = required("ASC_PROFILE_PATH");
const certificateSerial = normalizeSerial(required("ASC_CERTIFICATE_SERIAL"));
const privateKey = await importPKCS8(required("ASC_PRIVATE_KEY").replaceAll("\\n", "\n"), "ES256");
let token = "";
let tokenExpiresAt = 0;

const bundleIds = await all(`/v1/bundleIds?${new URLSearchParams({
  "filter[identifier]": bundleIdentifier,
  limit: "20",
})}`);
const bundleId = bundleIds.find((candidate) => candidate.attributes?.identifier === bundleIdentifier);
if (!bundleId) throw new Error(`Bundle ID ${bundleIdentifier} was not found`);

const capabilities = await all(`/v1/bundleIds/${bundleId.id}/bundleIdCapabilities`);
let nfcCapability = capabilities.find((candidate) => (
  candidate.attributes?.capabilityType === "NFC_TAG_READING"
));
if (!nfcCapability) {
  const created = await api("/v1/bundleIdCapabilities", {
    method: "POST",
    body: {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "NFC_TAG_READING" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleId.id } },
        },
      },
    },
  });
  nfcCapability = created.data;
}

const certificates = await all(`/v1/certificates?${new URLSearchParams({
  "fields[certificates]": "certificateType,displayName,serialNumber,expirationDate,certificateContent,activated",
  limit: "200",
})}`);
const certificate = certificates.find((candidate) => {
  const attributes = candidate.attributes ?? {};
  if (attributes.activated === false || Date.parse(attributes.expirationDate ?? "") <= Date.now()) return false;
  if (!["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(attributes.certificateType)) return false;
  const serials = [attributes.serialNumber, certificateContentSerial(attributes.certificateContent)]
    .filter(Boolean)
    .map(normalizeSerial);
  return serials.includes(certificateSerial);
});
if (!certificate) throw new Error("The uploaded distribution certificate was not found in the Apple account");

const matchingProfiles = await all(`/v1/profiles?${new URLSearchParams({
  "filter[name]": profileName,
  "filter[profileType]": "IOS_APP_STORE",
  "fields[profiles]": "name,profileType,profileState,profileContent,uuid,expirationDate",
  limit: "200",
})}`);
let profile = null;
for (const candidate of matchingProfiles) {
  if (candidate.attributes?.profileState === "ACTIVE") {
    const profileCertificates = await all(`/v1/profiles/${candidate.id}/certificates?limit=200`);
    if (profileCertificates.some((item) => item.id === certificate.id)) {
      profile = candidate;
      break;
    }
  }
}

if (!profile) {
  for (const candidate of matchingProfiles) {
    await api(`/v1/profiles/${candidate.id}`, { method: "DELETE" });
  }
  const created = await api("/v1/profiles", {
    method: "POST",
    body: {
      data: {
        type: "profiles",
        attributes: { name: profileName, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleId.id } },
          certificates: { data: [{ type: "certificates", id: certificate.id }] },
        },
      },
    },
  });
  profile = created.data;
}

const profileContent = profile.attributes?.profileContent;
if (!profileContent) throw new Error("Apple did not return provisioning profile content");
await writeFile(profilePath, Buffer.from(profileContent, "base64"), { mode: 0o600 });
console.log(JSON.stringify({
  bundleIdentifier,
  nfcCapabilityId: nfcCapability.id,
  profileId: profile.id,
  profileName: profile.attributes.name,
  profileUuid: profile.attributes.uuid,
  profileExpiration: profile.attributes.expirationDate,
}, null, 2));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeSerial(value) {
  return value.replaceAll(/[^a-fA-F0-9]/g, "").replace(/^0+/, "").toUpperCase();
}

function certificateContentSerial(content) {
  if (!content) return "";
  try {
    return new X509Certificate(Buffer.from(content, "base64")).serialNumber;
  } catch {
    return "";
  }
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
    const details = payload?.errors?.map((error) => (
      `${error.code ?? response.status}: ${error.detail ?? error.title}`
    )).join("; ") ?? `${response.status} ${response.statusText}`;
    const apiError = new Error(`${options.method ?? "GET"} ${new URL(url).pathname} failed: ${details}`);
    apiError.status = response.status;
    throw apiError;
  }
  return payload;
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
