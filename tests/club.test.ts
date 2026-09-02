import { describe, expect, it } from "vitest";
import { ClubDataProtector } from "../src/club.js";

const secret = "club-test-key-that-is-at-least-thirty-two-characters";

describe("ClubDataProtector", () => {
  it("creates stable keyed card fingerprints without exposing the identifier", () => {
    const protector = new ClubDataProtector(secret);
    const first = protector.fingerprint("04A1B2C3D4E5F6", "mifare");
    const second = protector.fingerprint("04a1b2c3d4e5f6", "mifare");

    expect(first).toBe(second);
    expect(protector.fingerprint("04a1b2c3d4e5f6", "iso7816")).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("04a1b2c3d4e5f6");
  });

  it("encrypts and authenticates member profiles", () => {
    const protector = new ClubDataProtector(secret);
    const profile = {
      name: "Scarlet Tester",
      age: 20,
      contactType: "instagram" as const,
      contact: "@scarlet_tester",
      grade: "junior" as const,
    };
    const sealed = protector.seal(profile);

    expect(sealed).not.toContain(profile.name);
    expect(sealed).not.toContain(profile.contact);
    expect(protector.open(sealed)).toEqual(profile);
    expect(() => protector.open(`${sealed.slice(0, -1)}A`)).toThrow();
  });
});
