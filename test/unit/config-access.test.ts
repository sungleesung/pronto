import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveAccess, loadConfig } from "../../packages/cli/src/config";

const base = {
  chatKeySalt: "x".repeat(48),
  imsgPath: "/opt/homebrew/bin/imsg",
  primaryRuntime: "claude",
  tags: ["@cory"],
  unrestrictedTrustVersion: 1,
  version: 2,
  workingDirectory: "/tmp",
};

async function withConfig<T>(extra: object, run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pronto-access-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ ...base, ...extra }));
    return await run(path);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("a config without an access policy keeps working and means everyone", async () => {
  await withConfig({}, async (path) => {
    const config = await loadConfig(path);
    expect(config.access).toBeUndefined();
    expect(effectiveAccess(config)).toEqual({ mode: "everyone" });
  });
});

test("an allowlist round-trips", async () => {
  await withConfig({ access: { handles: ["+18184001133"], mode: "allowlist" } }, async (path) => {
    expect(effectiveAccess(await loadConfig(path)))
      .toEqual({ handles: ["+18184001133"], mode: "allowlist" });
  });
});

test("a malformed policy is refused, never quietly widened to everyone", async () => {
  for (const access of [
    { mode: "all" },
    { mode: "allowlist" },
    { handles: "nope", mode: "allowlist" },
    { handles: [42], mode: "allowlist" },
    "everyone",
  ]) {
    await withConfig({ access }, async (path) => {
      await expect(loadConfig(path)).rejects.toThrow("Invalid access policy");
    });
  }
});
