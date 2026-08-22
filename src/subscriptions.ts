import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import type { AppConfig } from "./config.js";
import type { StoreTransactionEntitlement } from "./types.js";

export interface VerifiedSubscriptionNotification {
  notificationType: string;
  transaction: StoreTransactionEntitlement | null;
}

export interface SubscriptionVerifier {
  verifyTransaction(signedTransaction: string, installationId?: string): Promise<StoreTransactionEntitlement>;
  verifyNotification(signedPayload: string): Promise<VerifiedSubscriptionNotification>;
}

export class AppStoreSubscriptionVerifier implements SubscriptionVerifier {
  private readonly productionVerifier: SignedDataVerifier;
  private readonly sandboxVerifier: SignedDataVerifier;
  private readonly productIds: Set<string>;

  constructor(config: AppConfig["entitlements"]) {
    const roots = readdirSync(config.appleRootCaDirectory)
      .filter((name) => name.endsWith(".cer"))
      .sort()
      .map((name) => readFileSync(join(config.appleRootCaDirectory, name)));
    if (roots.length === 0) throw new Error("No Apple root certificates are configured");
    this.productionVerifier = new SignedDataVerifier(
      roots,
      true,
      Environment.PRODUCTION,
      config.bundleId,
      config.appAppleId,
    );
    this.sandboxVerifier = new SignedDataVerifier(
      roots,
      true,
      Environment.SANDBOX,
      config.bundleId,
    );
    this.productIds = new Set(config.productIds);
  }

  async verifyTransaction(signedTransaction: string, installationId?: string): Promise<StoreTransactionEntitlement> {
    const decoded = await this.verifyWithEitherEnvironment(signedTransaction);
    return this.toEntitlement(decoded, installationId);
  }

  async verifyNotification(signedPayload: string): Promise<VerifiedSubscriptionNotification> {
    const attempts = [
      { verifier: this.productionVerifier, environment: Environment.PRODUCTION },
      { verifier: this.sandboxVerifier, environment: Environment.SANDBOX },
    ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const notification = await attempt.verifier.verifyAndDecodeNotification(signedPayload);
        const signedTransaction = notification.data?.signedTransactionInfo;
        const transaction = signedTransaction
          ? this.toEntitlement(await attempt.verifier.verifyAndDecodeTransaction(signedTransaction))
          : null;
        return {
          notificationType: String(notification.notificationType ?? "UNKNOWN"),
          transaction,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The App Store notification could not be verified");
  }

  private async verifyWithEitherEnvironment(signedTransaction: string): Promise<JWSTransactionDecodedPayload> {
    let lastError: unknown;
    for (const verifier of [this.productionVerifier, this.sandboxVerifier]) {
      try {
        return await verifier.verifyAndDecodeTransaction(signedTransaction);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The App Store transaction could not be verified");
  }

  private toEntitlement(
    transaction: JWSTransactionDecodedPayload,
    installationId?: string,
  ): StoreTransactionEntitlement {
    const productId = transaction.productId ?? "";
    const originalTransactionId = transaction.originalTransactionId ?? "";
    const transactionId = transaction.transactionId ?? "";
    const expiresDate = transaction.expiresDate;
    const environment = transaction.environment;
    if (!this.productIds.has(productId)) throw new Error("The transaction is not for a Catalyst Watch Pro product");
    if (!originalTransactionId || !transactionId || !expiresDate) throw new Error("The subscription transaction is incomplete");
    if (environment !== Environment.PRODUCTION && environment !== Environment.SANDBOX) {
      throw new Error("The subscription transaction environment is invalid");
    }
    return {
      ...(installationId ? { installationId } : {}),
      productId,
      originalTransactionId,
      transactionId,
      expiresAt: new Date(expiresDate).toISOString(),
      environment,
      revoked: Boolean(transaction.revocationDate),
    };
  }
}
