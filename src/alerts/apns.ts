import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type { AppConfig } from "../config.js";
import type { AnalysisRecord, DeviceRegistration, NormalizedItem } from "../types.js";

export const HIGH_ALERT_SOUND = "CatalystHigh.caf";
export const URGENT_ALERT_SOUND = "CatalystUrgent.caf";

export interface ApnsResult {
  ok: boolean;
  status: number;
  apnsId: string | null;
  reason: string | null;
}

export class ApnsClient {
  private signingKey: CryptoKey | null = null;
  private providerToken: string | null = null;
  private providerTokenCreatedAt = 0;

  constructor(private readonly config: AppConfig["apns"]) {}

  get configured(): boolean {
    return Boolean(this.config.teamId && this.config.keyId && this.config.bundleId
      && (this.config.privateKey || this.config.privateKeyPath));
  }

  async send(
    device: DeviceRegistration,
    item: NormalizedItem,
    analysis: AnalysisRecord,
  ): Promise<ApnsResult> {
    if (!this.configured) throw new Error("APNs is not configured");
    const critical = this.config.allowCritical && device.criticalAuthorized && analysis.alertTier === "urgent";
    const timeSensitive = !critical && device.timeSensitiveAuthorized
      && (analysis.alertTier === "high" || analysis.alertTier === "urgent");
    const payload = buildApnsPayload(
      item,
      analysis,
      critical,
      timeSensitive,
      device.attentionSoundsSupported,
    );
    const token = await this.getProviderToken();
    const origin = device.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const session = connect(origin);
    try {
      return await sendHttp2(session, device.deviceToken, payload, {
        authorization: `bearer ${token}`,
        topic: this.config.bundleId,
        collapseId: analysis.eventKey ?? item.id,
      });
    } finally {
      session.close();
    }
  }

  private async getProviderToken(): Promise<string> {
    if (this.providerToken && Date.now() - this.providerTokenCreatedAt < 50 * 60 * 1000) return this.providerToken;
    if (!this.signingKey) {
      const pem = this.config.privateKey || readFileSync(this.config.privateKeyPath, "utf8");
      this.signingKey = await importPKCS8(pem, "ES256");
    }
    this.providerToken = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(this.signingKey);
    this.providerTokenCreatedAt = Date.now();
    return this.providerToken;
  }
}

export function buildApnsPayload(
  item: NormalizedItem,
  analysis: AnalysisRecord,
  critical: boolean,
  timeSensitive = true,
  attentionSoundsSupported = false,
): Record<string, unknown> {
  const assessment = analysis.assessment;
  const range = formatRange(assessment.expectedMoveLowPct, assessment.expectedMoveHighPct);
  const interruptionLevel = critical ? "critical" : timeSensitive ? "time-sensitive" : "active";
  const ticker = assessment.ticker || item.tickerHint || "Biotech";
  const tier = analysis.alertTier.toUpperCase();
  return {
    aps: {
      alert: {
        title: `${tier} · ${ticker}`,
        subtitle: `${assessment.marketMateriality ?? assessment.materiality}/100 market materiality · ${(assessment.confidence * 100).toFixed(0)}% confidence`,
        body: `${item.headline}\nScenario range: ${range}. Verify the primary source before acting.`,
      },
      sound: alertSound(analysis.alertTier, critical, attentionSoundsSupported),
      badge: 1,
      "interruption-level": interruptionLevel,
      "relevance-score": Math.min(1, Math.max(0, analysis.policyScore / 100)),
      "thread-id": assessment.ticker || item.tickerHint || "biotech",
      category: "CATALYST_SIGNAL",
    },
    signalId: item.id,
    sourceUrl: item.url,
    disclaimer: "Probabilistic decision support; not a trading instruction.",
  };
}

function alertSound(tier: AnalysisRecord["alertTier"], critical: boolean, supported: boolean): string | Record<string, unknown> {
  const name = supported
    ? tier === "urgent" ? URGENT_ALERT_SOUND : HIGH_ALERT_SOUND
    : "default";
  return critical ? { critical: 1, name, volume: 1 } : name;
}

function sendHttp2(
  session: ClientHttp2Session,
  deviceToken: string,
  payload: Record<string, unknown>,
  headers: { authorization: string; topic: string; collapseId: string },
): Promise<ApnsResult> {
  return new Promise((resolve, reject) => {
    let responseBody = "";
    let status = 0;
    let apnsId: string | null = null;
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: headers.authorization,
      "apns-topic": headers.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      "apns-collapse-id": headers.collapseId.slice(0, 64),
      "content-type": "application/json",
    });
    request.setEncoding("utf8");
    request.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"] ?? 0);
      const value = responseHeaders["apns-id"];
      apnsId = Array.isArray(value) ? value[0] ?? null : value?.toString() ?? null;
    });
    request.on("data", (chunk: string) => { responseBody += chunk; });
    request.on("end", () => {
      let reason: string | null = null;
      try {
        reason = responseBody ? (JSON.parse(responseBody) as { reason?: string }).reason ?? responseBody : null;
      } catch {
        reason = responseBody || null;
      }
      resolve({ ok: status === 200, status, apnsId, reason });
    });
    request.on("error", reject);
    request.end(JSON.stringify(payload));
  });
}

function formatRange(low: number, high: number): string {
  const format = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(0)}%`;
  return `${format(Math.min(low, high))} to ${format(Math.max(low, high))}`;
}
