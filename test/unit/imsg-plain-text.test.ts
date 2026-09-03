import { describe, expect, test } from "bun:test";
import { plainTextFromMarkdown } from "../../packages/cli/src/imessage/plain-text";

describe("plainTextFromMarkdown", () => {
  test("removes the emphasis that shipped to a real chat", () => {
    expect(plainTextFromMarkdown("1. **FetishCon** (various cities, annual)")).toBe(
      "1. FetishCon (various cities, annual)",
    );
  });

  test("flattens the common markers", () => {
    expect(plainTextFromMarkdown("**bold**")).toBe("bold");
    expect(plainTextFromMarkdown("__bold__")).toBe("bold");
    expect(plainTextFromMarkdown("*italic*")).toBe("italic");
    expect(plainTextFromMarkdown("***both***")).toBe("both");
    expect(plainTextFromMarkdown("~~struck~~")).toBe("struck");
    expect(plainTextFromMarkdown("`code`")).toBe("code");
    expect(plainTextFromMarkdown("## Heading")).toBe("Heading");
    expect(plainTextFromMarkdown("> quoted")).toBe("quoted");
  });

  test("keeps a link's destination, which is tappable in Messages", () => {
    expect(plainTextFromMarkdown("see [the docs](https://example.com/a)")).toBe(
      "see the docs (https://example.com/a)",
    );
    expect(plainTextFromMarkdown("[https://example.com](https://example.com)")).toBe(
      "https://example.com",
    );
    expect(plainTextFromMarkdown("![a diagram](https://example.com/i.png)")).toBe("a diagram");
  });

  test("unwraps fenced code without losing the body", () => {
    expect(plainTextFromMarkdown("before\n```ts\nconst a = 1;\n```\nafter")).toBe(
      "before\nconst a = 1;\nafter",
    );
  });

  test("normalizes bullets to a character Messages renders", () => {
    expect(plainTextFromMarkdown("- one\n* two\n  - nested")).toBe("• one\n• two\n  • nested");
  });

  // The conservative half: these must survive untouched.
  test("preserves underscores in identifiers and paths", () => {
    expect(plainTextFromMarkdown("run snake_case_name now")).toBe("run snake_case_name now");
    expect(plainTextFromMarkdown("packages/cli/src/reply_format.ts")).toBe(
      "packages/cli/src/reply_format.ts",
    );
    expect(plainTextFromMarkdown("PRONTO_CODESIGN_IDENTITY")).toBe("PRONTO_CODESIGN_IDENTITY");
  });

  test("preserves a spaced asterisk used as multiplication", () => {
    expect(plainTextFromMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(plainTextFromMarkdown("cost is 4 * 5")).toBe("cost is 4 * 5");
  });

  test("leaves already-plain text alone", () => {
    const report = [
      "Latency for this message:",
      "  detect   8.2s  Messages to queue",
      "  handle   0.0s  queue to this reply",
      "",
      "Model half, last 5: 20.3s · 37.0s (median 20.7s)",
    ].join("\n");
    expect(plainTextFromMarkdown(report)).toBe(report);
  });
});
