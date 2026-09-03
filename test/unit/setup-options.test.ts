import { describe, expect, test } from "bun:test";
import { parseSetupOptions } from "../../packages/cli/src/setup-options";

describe("parseSetupOptions", () => {
  test("an empty invocation pre-answers nothing, so setup still asks", () => {
    expect(parseSetupOptions([])).toEqual({ acceptTrust: false });
  });

  test("reads a full unattended invocation", () => {
    expect(parseSetupOptions([
      "--tag", "@cory", "--working-directory", "/Users/x/cory",
      "--runtime", "claude", "--no-fallback",
      "--access", "allowlist", "--allow", "+18184001133", "--allow", "a@b.com",
      "--accept-trust",
    ])).toEqual({
      acceptTrust: true,
      access: { handles: ["+18184001133", "a@b.com"], mode: "allowlist" },
      fallback: false,
      runtime: "claude",
      tags: ["@cory"],
      workingDirectory: "/Users/x/cory",
    });
  });

  test("normalizes tags the same way the prompt does", () => {
    expect(parseSetupOptions(["--tag", "Cory, @Helper"]).tags).toEqual(["@cory", "@helper"]);
  });

  test("trust is never implied — it has to be stated", () => {
    expect(parseSetupOptions(["--tag", "@cory"]).acceptTrust).toBe(false);
  });

  test("--allow without --access still means an allowlist, never everyone", () => {
    expect(parseSetupOptions(["--allow", "+1818"]).access)
      .toEqual({ handles: ["+1818"], mode: "allowlist" });
  });

  test("an explicit everyone is honoured", () => {
    expect(parseSetupOptions(["--access", "everyone"]).access).toEqual({ mode: "everyone" });
  });

  test("rejects malformed input rather than guessing", () => {
    expect(() => parseSetupOptions(["--access", "some"])).toThrow("everyone or allowlist");
    expect(() => parseSetupOptions(["--runtime", "gpt"])).toThrow("codex or claude");
    expect(() => parseSetupOptions(["--tag"])).toThrow("needs a value");
    expect(() => parseSetupOptions(["--tag", "--runtime"])).toThrow("needs a value");
    expect(() => parseSetupOptions(["--nope"])).toThrow("Unknown setup option");
  });
});
