import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SignalDatabase } from "../db.js";
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
    private readonly db: SignalDatabase,
  ) {
    this.apns = new ApnsClient(config.apns);
  }

  async dispatch(item: NormalizedItem, analysis: AnalysisRecord): Promise<AlertDispatchSummary> {
    if (analysis.alertTier !== "urgent") {
      return { attempted: 0, sent: 0, failed: 0, dryRun: this.config.alertPolicy.dryRun, suppressedReason: "not_urgent" };
    }
    const ticker = analysis.assessment.ticker;
    const eventType = analysis.assessment.eventType;
    const cooldownSince = new Date(Date.now() - this.config.alertPolicy.cooldownMinutes * 60_000).toISOString();
    if (this.db.hasRecentAlert(ticker, eventType, cooldownSince)) {
      this.db.saveAlert({
        id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier,
        status: "suppressed", response: { reason: "cooldown" },
      });
      return { attempted: 0, sent: 0, failed: 0, dryRun: this.config.alertPolicy.dryRun, suppressedReason: "cooldown" };
    }

    if (this.config.alertPolicy.dryRun || !this.apns.configured) {
      this.db.saveAlert({
        id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier,
        status: "dry_run", response: { apnsConfigured: this.apns.configured },
      });
      return { attempted: 0, sent: 0, failed: 0, dryRun: true, suppressedReason: this.apns.configured ? null : "apns_not_configured" };
    }

    const devices = this.db.listAlertDevices();
    let sent = 0;
    let failed = 0;
    for (const device of devices) {
      try {
        const result = await this.apns.send(device, item, analysis);
        if (result.ok) sent += 1;
        else failed += 1;
        this.db.saveAlert({
          id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier,
          status: result.ok ? "sent" : "failed", deviceToken: device.deviceToken, response: result,
        });
        if ([400, 410].includes(result.status) && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason ?? "")) {
          this.db.deactivateDevice(device.deviceToken);
        }
      } catch (error) {
        failed += 1;
        this.db.saveAlert({
          id: randomUUID(), itemId: item.id, ticker, eventType, tier: analysis.alertTier,
          status: "failed", deviceToken: device.deviceToken,
          response: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return { attempted: devices.length, sent, failed, dryRun: false, suppressedReason: devices.length ? null : "no_devices" };
  }
}
