import { expect, test } from "bun:test";
import { legacyPathsForHome, pathsForHome } from "../../packages/cli/src/macos/paths";

test("derives one owner-scoped service layout", () => {
  expect(pathsForHome("/Users/example")).toEqual({
    appSupportDirectory: "/Users/example/Library/Application Support/cory",
    configPath: "/Users/example/Library/Application Support/cory/config.json",
    databasePath: "/Users/example/Library/Application Support/cory/state.sqlite",
    executablePath: "/Users/example/Library/Application Support/cory/bin/cory",
    launchAgentPath: "/Users/example/Library/LaunchAgents/net.trycrate.cory.agent.plist",
    logDirectory: "/Users/example/Library/Logs/cory",
    logPath: "/Users/example/Library/Logs/cory/daemon.log",
    providerStatePath: "/Users/example/Library/Application Support/cory/provider-state.json",
  });
});

test("retains the legacy layout only for migration", () => {
  expect(legacyPathsForHome("/Users/example")).toEqual({
    appSupportDirectory: "/Users/example/Library/Application Support/pronto",
    configPath: "/Users/example/Library/Application Support/pronto/config.json",
    databasePath: "/Users/example/Library/Application Support/pronto/state.sqlite",
    executablePath: "/Users/example/Library/Application Support/pronto/bin/pronto",
    launchAgentPath: "/Users/example/Library/LaunchAgents/dev.pronto.agent.plist",
    logDirectory: "/Users/example/Library/Logs/pronto",
    logPath: "/Users/example/Library/Logs/pronto/daemon.log",
    providerStatePath: "/Users/example/Library/Application Support/pronto/provider-state.json",
  });
});
