import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SignalStore } from "../store.js";
import type { AnalysisRecord, NormalizedItem } from "../types.js";
import { ApnsClient } from "./apns.js";

export interface AlertDispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  dryRun: boolean;
  suppressedReason: string | null;
}

export class AlertService {
  private readonly apns: ApnsClient;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SignalStore,
  ) {
    this.apns = new ApnsClient(config.apns);
  }

  async dispatch(item: NormalizedItem, analysis: AnalysisRecord): Promise<AlertDispatchSummary> {
    if (analysis.alertTier !== "high" && analysis.alertTier !== "urgent") {
      return { attempted: 0, sent: 0, failed: 0, dryRun: this.config.alertPolicy.dryRun, suppressedReason: "below_high" };
    }
    const ticker = analysis.assessment.ticker;
    const eventType = analysis.assessment.eventType;
    const eventKey = analysis.eventKey ?? `${ticker}:${eventType}:${item.id}`;
    const eventAt = analysis.eventAnchorAt ?? item.publishedAt;
    const maxAgeMs = (this.config.alertPolicy.maxAgeMinutes ?? 30) * 60_000;
    if (!Number.isFinite(Date.parse(eventAt)) || Date.now() - Date.parse(eventAt) > maxAgeMs) {
      await this.db.saveAlert({
        id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier, eventKey,
        status: "suppressed", response: { reason: "stale_event", eventAt },
      });
      return { attempted: 0, sent: 0, failed: 0, dryRun: this.config.alertPolicy.dryRun, suppressedReason: "stale_event" };
    }
    const cooldownMs = (this.config.alertPolicy.cooldownMinutes ?? 240) * 60_000;
    const eventHistorySince = new Date(Date.now() - cooldownMs).toISOString();
    const claim = {
      id: randomUUID(),
      itemId: item.id,
      ticker,
      eventType,
      tier: analysis.alertTier,
      eventKey,
      status: "claimed" as const,
      response: { reason: "dispatch_in_progress" },
    };
    const claimed = this.db.tryClaimAlertEvent
      ? await this.db.tryClaimAlertEvent(claim, eventHistorySince)
      : !await this.db.hasRecentAlert(eventKey, analysis.alertTier, eventHistorySince);
    if (!claimed) {
      await this.db.saveAlert({
        id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier, eventKey,
        status: "suppressed", response: { reason: "cooldown" },
      });
      return { attempted: 0, sent: 0, failed: 0, dryRun: this.config.alertPolicy.dryRun, suppressedReason: "cooldown" };
    }

    if (this.config.alertPolicy.dryRun || !this.apns.configured) {
      await this.db.saveAlert({
        ...claim,
        status: "dry_run", response: { apnsConfigured: this.apns.configured },
      });
      return { attempted: 0, sent: 0, failed: 0, dryRun: true, suppressedReason: this.apns.configured ? null : "apns_not_configured" };
    }

    const devices = await this.db.listAlertDevices(ticker, eventType, analysis.alertTier);
    let sent = 0;
    let failed = 0;
    for (const device of devices) {
      try {
        const result = await this.apns.send(device, item, analysis);
        if (result.ok) sent += 1;
        else failed += 1;
        await this.db.saveAlert({
          id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier, eventKey,
          status: result.ok ? "sent" : "failed", deviceToken: device.deviceToken, response: result,
        });
        if ([400, 410].includes(result.status) && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason ?? "")) {
          await this.db.deactivateDevice(device.deviceToken);
        }
      } catch (error) {
        failed += 1;
        await this.db.saveAlert({
          id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier, eventKey,
          status: "failed", deviceToken: device.deviceToken,
          response: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    await this.db.saveAlert({
      ...claim,
      status: sent > 0 ? "suppressed" : "failed",
      response: { reason: "claim_completed", attempted: devices.length, sent, failed },
    });
    return { attempted: devices.length, sent, failed, dryRun: false, suppressedReason: devices.length ? null : "no_devices" };
  }
}
