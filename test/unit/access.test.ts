import { describe, expect, test } from "bun:test";
import {
  canonicalHandle,
  isAccessPolicy,
  senderAllowed,
  type AccessPolicy,
} from "../../packages/cli/src/access";

const list = (...handles: string[]): AccessPolicy => ({ handles, mode: "allowlist" });

describe("canonicalHandle", () => {
  test("matches one person across the shapes Messages records", () => {
    const forms = ["+18184001133", "18184001133", "8184001133", "(818) 400-1133", "818-400-1133"];
    const canonical = forms.map(canonicalHandle);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("8184001133");
  });

  test("lower-cases email addresses and leaves them intact", () => {
    expect(canonicalHandle("  Name@Example.COM ")).toBe("name@example.com");
  });

  test("does not collapse different numbers together", () => {
    expect(canonicalHandle("+18184001133")).not.toBe(canonicalHandle("+18288087243"));
  });
});

describe("senderAllowed", () => {
  test("the owner is always allowed", () => {
    expect(senderAllowed(list(), { fromMe: true, sender: null })).toBe(true);
    expect(senderAllowed(list("+15550000000"), { fromMe: true, sender: "+19998887777" })).toBe(true);
  });

  test("everyone means everyone", () => {
    expect(senderAllowed({ mode: "everyone" }, { fromMe: false, sender: "+19998887777" }))
      .toBe(true);
    expect(senderAllowed({ mode: "everyone" }, { fromMe: false, sender: null })).toBe(true);
  });

  test("an allowlist admits its members in any format", () => {
    const policy = list("+1 (818) 400-1133", "friend@example.com");
    expect(senderAllowed(policy, { fromMe: false, sender: "8184001133" })).toBe(true);
    expect(senderAllowed(policy, { fromMe: false, sender: "+18184001133" })).toBe(true);
    expect(senderAllowed(policy, { fromMe: false, sender: "FRIEND@example.com" })).toBe(true);
  });

  test("and refuses everyone else, including an unknown sender", () => {
    const policy = list("+18184001133");
    expect(senderAllowed(policy, { fromMe: false, sender: "+18288087243" })).toBe(false);
    expect(senderAllowed(policy, { fromMe: false, sender: null })).toBe(false);
    expect(senderAllowed(policy, { fromMe: false, sender: "" })).toBe(false);
    expect(senderAllowed(list(), { fromMe: false, sender: "+18184001133" })).toBe(false);
  });
});

describe("isAccessPolicy", () => {
  test("accepts the two valid shapes", () => {
    expect(isAccessPolicy({ mode: "everyone" })).toBe(true);
    expect(isAccessPolicy({ handles: [], mode: "allowlist" })).toBe(true);
    expect(isAccessPolicy({ handles: ["+1"], mode: "allowlist" })).toBe(true);
  });

  test("rejects anything else, so a malformed config cannot silently open access", () => {
    for (const value of [null, undefined, "everyone", { mode: "all" }, { mode: "allowlist" },
      { handles: "x", mode: "allowlist" }, { handles: [1], mode: "allowlist" }]) {
      expect(isAccessPolicy(value)).toBe(false);
    }
  });
});
