import { describe, expect, test } from "bun:test";
import {
  MAX_BUBBLE_CHARACTERS,
  splitReplyText,
} from "../../packages/cli/src/imessage/split-reply";

const within = (parts: readonly string[], limit = MAX_BUBBLE_CHARACTERS) =>
  parts.every((part) => part.length <= limit);

describe("splitReplyText", () => {
  test("leaves a normal reply as a single bubble", () => {
    expect(splitReplyText("Pong — up and running.")).toEqual(["Pong — up and running."]);
  });

  test("returns nothing for empty text", () => {
    expect(splitReplyText("")).toEqual([]);
    expect(splitReplyText("   \n  ")).toEqual([]);
  });

  test("splits on blank lines and keeps every bubble within the limit", () => {
    const paragraph = "x".repeat(700);
    const parts = splitReplyText([paragraph, paragraph, paragraph].join("\n\n"));
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts)).toBe(true);
  });

  test("keeps a list's lines together rather than cutting mid-item", () => {
    const lines = Array.from({ length: 60 }, (_v, i) => `${i + 1}. step number ${i + 1}`);
    const parts = splitReplyText(lines.join("\n"), 400);
    expect(within(parts, 400)).toBe(true);
    // No bubble may begin or end mid-item.
    for (const part of parts) {
      expect(part.startsWith(" ")).toBe(false);
      expect(/\d+\. step number \d+$/u.test(part.trim())).toBe(true);
    }
    expect(parts.join("\n")).toBe(lines.join("\n"));
  });

  test("hard wraps a single line longer than a whole bubble", () => {
    const words = Array.from({ length: 400 }, () => "word").join(" ");
    const parts = splitReplyText(words, 200);
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts, 200)).toBe(true);
    expect(parts.every((part) => !part.startsWith(" "))).toBe(true);
  });

  test("preserves all the words when wrapping", () => {
    const words = Array.from({ length: 120 }, (_v, i) => `w${i}`).join(" ");
    expect(splitReplyText(words, 100).join(" ").split(/\s+/u)).toEqual(words.split(" "));
  });
});
