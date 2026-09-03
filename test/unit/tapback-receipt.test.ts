import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RECEIPT_REACTION,
  isTapbackReaction,
  TAPBACK_REACTIONS,
} from "../../packages/cli/src/imessage/tapback";

describe("tapback vocabulary", () => {
  test("Messages offers six tapbacks and a checkmark is not one of them", () => {
    expect([...TAPBACK_REACTIONS]).toEqual([
      "love", "like", "dislike", "laugh", "emphasis", "question",
    ]);
    expect(isTapbackReaction("check")).toBe(false);
    expect(isTapbackReaction("checkmark")).toBe(false);
    expect(isTapbackReaction("✓")).toBe(false);
  });

  test("a thumbs up is the stand-in for 'received, working on it'", () => {
    expect(DEFAULT_RECEIPT_REACTION).toBe("like");
    expect(isTapbackReaction(DEFAULT_RECEIPT_REACTION)).toBe(true);
  });

  test("rejects near misses so a bad override falls back to the default", () => {
    expect(isTapbackReaction("LIKE")).toBe(false);
    expect(isTapbackReaction("thumbsup")).toBe(false);
    expect(isTapbackReaction(undefined)).toBe(false);
    expect(isTapbackReaction(7)).toBe(false);
  });
});
