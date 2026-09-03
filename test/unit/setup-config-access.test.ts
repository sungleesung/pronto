import { expect, test } from "bun:test";
import { prepareSetupConfig } from "../../packages/cli/src/macos/setup";

const discovery = {
  imsgPath: "/opt/homebrew/bin/imsg",
  runtimes: { claude: "/opt/homebrew/bin/claude" },
} as never;

test("an access policy survives into the written config", () => {
  const config = prepareSetupConfig({
    access: { handles: ["+18184001133"], mode: "allowlist" },
    discovery,
    primaryRuntime: "claude",
    tags: ["@cory"],
    workingDirectory: "/tmp/cory",
  });
  // A spread into an object literal skips excess-property checking, so this is the only
  // thing standing between a configured allowlist and one that is silently discarded.
  expect(config.access).toEqual({ handles: ["+18184001133"], mode: "allowlist" });
});

test("omitting it leaves the field absent, which means everyone", () => {
  const config = prepareSetupConfig({
    discovery, primaryRuntime: "claude", tags: ["@cory"], workingDirectory: "/tmp/cory",
  });
  expect(config.access).toBeUndefined();
});
