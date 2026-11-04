import { sign } from "node:crypto";
const required = name => { if (!process.env[name]) throw new Error(`Missing ${name}`); return process.env[name]; };
const app = required("ASC_APP_ID");
const now = Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${encode({ alg: "ES256", kid: required("ASC_KEY_ID"), typ: "JWT" })}.${encode({ iss: required("ASC_ISSUER_ID"), iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
const token = `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: required("ASC_PRIVATE_KEY").replaceAll("\\n", "\n"), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Apple metadata request failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
const description = "Flight & Aerospace Academy's instructor workspace brings student progress, practical skills, Onshape lessons, team projects, homework, and semester goals into one iPhone app. Explore the sample workspace, record individual assessment evidence, and share progress reports. Academy rosters are imported privately and are not included in public test builds. Approved instructors can sync through the academy server using private access codes or linked instructor NFC cards. Offline changes sync when connected.";
const beta = (await api(`/v1/apps/${app}/betaAppLocalizations?limit=200`)).data;
const english = beta.find(item => item.attributes.locale === "en-US");
if (english) await api(`/v1/betaAppLocalizations/${english.id}`, "PATCH", { data: { type: "betaAppLocalizations", id: english.id, attributes: { description, marketingUrl: "https://flightaerospace.academy/" } } });
else await api("/v1/betaAppLocalizations", "POST", { data: { type: "betaAppLocalizations", attributes: { locale: "en-US", description, marketingUrl: "https://flightaerospace.academy/" }, relationships: { app: { data: { type: "apps", id: app } } } } });
console.log("Academy beta description updated.");
// Rename only editable app information. Do not create or submit an App Store release.
const infos = (await api(`/v1/apps/${app}/appInfos?limit=200`)).data;
let renamed = false;
for (const info of infos.filter(x => x.attributes.state === "PREPARE_FOR_SUBMISSION" || x.attributes.state === "DEVELOPER_REJECTED")) {
  const locales = (await api(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`)).data;
  for (const locale of locales.filter(x => x.attributes.locale === "en-US")) {
    try {
      await api(`/v1/appInfoLocalizations/${locale.id}`, "PATCH", { data: { type: "appInfoLocalizations", id: locale.id, attributes: { name: "Flight & Aerospace Academy", subtitle: "Skills, projects and progress" } } });
      renamed = true;
    } catch (error) { console.log(`App name remains unchanged: ${error.message}`); }
  }
}
console.log(renamed ? "Editable app information renamed to Flight & Aerospace Academy." : "Apple's app name has no editable localization; public name may remain Catalyst Watch until an App Store metadata update is approved.");
