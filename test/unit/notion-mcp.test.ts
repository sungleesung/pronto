import { describe, expect, test } from "bun:test";
import { higgsfieldMcpServer, notionMcpServer } from "../../packages/cli/src/runtimes/claude";

describe("optional Notion MCP server", () => {
  test("is absent without a token, so the model is never shown tools that cannot work", () => {
    expect(notionMcpServer(undefined)).toEqual({});
    expect(notionMcpServer("")).toEqual({});
    expect(notionMcpServer("   ")).toEqual({});
  });

  test("is configured for stdio with the token in its own environment", () => {
    expect(notionMcpServer("ntn_secret")).toEqual({
      notion: {
        args: ["-y", "@notionhq/notion-mcp-server"],
        command: "npx",
        env: { NOTION_TOKEN: "ntn_secret" },
      },
    });
  });

  test("trims surrounding whitespace from a pasted token", () => {
    expect(notionMcpServer("  ntn_secret\n").notion?.env.NOTION_TOKEN).toBe("ntn_secret");
  });
});

describe("optional Higgsfield MCP server", () => {
  test("needs both halves of the credential, or it is absent", () => {
    expect(higgsfieldMcpServer(undefined, undefined)).toEqual({});
    expect(higgsfieldMcpServer("key", undefined)).toEqual({});
    expect(higgsfieldMcpServer(undefined, "secret")).toEqual({});
    expect(higgsfieldMcpServer("key", "  ")).toEqual({});
  });

  test("passes both through when configured", () => {
    expect(higgsfieldMcpServer(" key ", "secret ")).toEqual({
      higgsfield: {
        args: ["-y", "higgsfield-mcp"],
        command: "npx",
        env: { HF_API_KEY: "key", HF_SECRET: "secret" },
      },
    });
  });
});
