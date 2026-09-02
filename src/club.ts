import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { ClubCardTechnology, ClubMemberProfile } from "./types.js";

const AAD = Buffer.from("catalyst-watch-club-profile-v1", "utf8");

export class ClubDataProtector {
  private readonly cardKey: Buffer;
  private readonly profileKey: Buffer;

  constructor(secret: string) {
    if (secret.trim().length < 32) throw new Error("CLUB_DATA_KEY must contain at least 32 characters");
    const rootKey = createHash("sha256").update(secret, "utf8").digest();
    this.cardKey = createHmac("sha256", rootKey).update("card-fingerprint-v1").digest();
    this.profileKey = createHmac("sha256", rootKey).update("profile-encryption-v1").digest();
  }

  fingerprint(cardIdentifier: string, technology: ClubCardTechnology): string {
    const normalized = cardIdentifier.trim().toLowerCase();
    if (!/^(?:[a-f0-9]{2}){2,64}$/.test(normalized)) throw new Error("Invalid NFC card identifier");
    return createHmac("sha256", this.cardKey)
      .update(technology, "utf8")
      .update(Buffer.from([0]))
      .update(Buffer.from(normalized, "hex"))
      .digest("hex");
  }

  seal(profile: ClubMemberProfile): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.profileKey, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(profile), "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  open(sealed: string): ClubMemberProfile {
    const [version, ivValue, authTagValue, encryptedValue, ...extra] = sealed.split(".");
    if (version !== "v1" || !ivValue || !authTagValue || !encryptedValue || extra.length) {
      throw new Error("Unsupported encrypted club profile");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.profileKey, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(cleartext) as ClubMemberProfile;
  }
}
