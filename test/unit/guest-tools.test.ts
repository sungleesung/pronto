import { describe, expect, test } from "bun:test";
import { deniedToolsFor, GUEST_DENIED_TOOLS } from "../../packages/cli/src/guest-tools";

describe("guest capability boundary", () => {
  test("the owner keeps every tool", () => {
    expect(deniedToolsFor({ fromMe: true })).toEqual([]);
  });

  test("a guest loses the shell and the filesystem", () => {
    const denied = deniedToolsFor({ fromMe: false });
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]) {
      expect(denied).toContain(tool);
    }
  });

  test("a guest keeps what makes the assistant useful", () => {
    const denied = deniedToolsFor({ fromMe: false });
    // Conversation tools, search and the web are reached through MCP or the broker and
    // must survive, or a guest gets an agent that can do nothing at all.
    for (const tool of ["WebSearch", "WebFetch", "search_messages", "current_chat_history"]) {
      expect(denied).not.toContain(tool);
    }
  });

  test("the denied set is exactly what is documented, so a silent widening is visible", () => {
    expect([...GUEST_DENIED_TOOLS].sort()).toEqual(
      ["Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Write"].sort(),
    );
  });
});
