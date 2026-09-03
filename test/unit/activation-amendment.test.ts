import { describe, expect, test } from "bun:test";
import { amendmentBody, isAmendment } from "../../packages/cli/src/activation";

describe("btw amendments", () => {
  test("recognises the aside in the shapes people actually type", () => {
    for (const text of [
      "btw make it vegetarian",
      "BTW make it vegetarian",
      "btw, make it vegetarian",
      "btw: make it vegetarian",
      "  btw — make it vegetarian",
    ]) {
      expect(isAmendment(text)).toBe(true);
      expect(amendmentBody(text)).toBe("make it vegetarian");
    }
  });

  test("does not fire on words that merely start with btw", () => {
    expect(isAmendment("btwn the two options which is better")).toBe(false);
    expect(isAmendment("between these two")).toBe(false);
    expect(isAmendment("what does btw mean")).toBe(false);
  });

  test("a bare btw carries no revision", () => {
    expect(isAmendment("btw")).toBe(true);
    expect(amendmentBody("btw")).toBe("");
  });
});
