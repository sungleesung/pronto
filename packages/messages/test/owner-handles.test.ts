import { describe, expect, test } from "bun:test";
import {
  ownerHandlesFromAccountListing,
  selfChatMirrorPossible,
} from "../src/internal/owner";

describe("ownerHandlesFromAccountListing", () => {
  test("strips the kind prefix and de-duplicates", () => {
    expect([...ownerHandlesFromAccountListing({
      accounts: [
        { login: "E:someone@example.com" },
        { login: "P:+15551234567" },
        { login: "P:+15551234567" },
        { login: "E:" },
      ],
    })].sort()).toEqual(["+15551234567", "someone@example.com"]);
  });

  test("returns an empty set for anything malformed", () => {
    for (const value of [null, undefined, 42, [], {}, { accounts: "no" }, { accounts: [1, null] }]) {
      expect(ownerHandlesFromAccountListing(value).size).toBe(0);
    }
  });
});

describe("selfChatMirrorPossible", () => {
  const owners = new Set(["+15551234567", "someone@example.com"]);

  test("a conversation with the owner's own handle stays eligible", () => {
    expect(selfChatMirrorPossible(["+15551234567"], owners)).toBe(true);
    expect(selfChatMirrorPossible(["someone@example.com"], owners)).toBe(true);
  });

  test("a conversation with somebody else cannot contain a mirror", () => {
    expect(selfChatMirrorPossible(["+15559999999"], owners)).toBe(false);
    expect(selfChatMirrorPossible(["a@b.com", "+15558888888"], owners)).toBe(false);
  });

  test("a group including the owner stays eligible", () => {
    expect(selfChatMirrorPossible(["+15559999999", "+15551234567"], owners)).toBe(true);
  });

  // Failing open is the whole safety story: an unknown answer must not skip the scan,
  // because a missed mirror means replying twice to the same message.
  test("anything unknown fails open", () => {
    expect(selfChatMirrorPossible(undefined, owners)).toBe(true);
    expect(selfChatMirrorPossible([], owners)).toBe(true);
    expect(selfChatMirrorPossible(["+15559999999"], new Set())).toBe(true);
  });
});
