import { describe, expect, test } from "bun:test";
import { findTagRanges } from "../../packages/cli/src/activation";
import { acknowledgementText, formatImessageReplyText, imessageReplyBodyCharacterLimit } from "../../packages/cli/src/imessage/reply-format";

describe("iMessage reply formatting", () => {
  test("puts the triggering tag in title case on its own first line", () => {
    expect(formatImessageReplyText("@research", "I found the launch notes.")).toBe(
      "Research\n\nI found the launch notes.",
    );
  });

  test("preserves the rest of the tag spelling and punctuation", () => {
    expect(formatImessageReplyText("@studio_four-4", "Done.")).toBe(
      "Studio_four-4\n\nDone.",
    );
  });

  test("labels an empty response without creating a fresh activation", () => {
    const reply = formatImessageReplyText("@s4", "");
    expect(reply).toBe("S4");
    expect(findTagRanges(reply, "@s4")).toEqual([]);
  });

  test("reserves heading space inside the outbound character budget", () => {
    const limit = imessageReplyBodyCharacterLimit("@research", 4_000);
    expect(formatImessageReplyText("@research", "x".repeat(limit))).toHaveLength(4_000);
  });
});

test("acknowledgement names the tag and says what is happening", () => {
  expect(acknowledgementText("@cory")).toBe("Cory - Working on that now");
  expect(acknowledgementText("cory")).toBe("Cory - Working on that now");
  expect(acknowledgementText("@helper")).toBe("Helper - Working on that now");
});

test("the acknowledgement says where a request sits in the queue", () => {
  expect(acknowledgementText("@cory")).toBe("Cory - Working on that now");
  expect(acknowledgementText("@cory", 0)).toBe("Cory - Working on that now");
  expect(acknowledgementText("@cory", 1)).toBe("Cory - Got it, finishing one before this");
  expect(acknowledgementText("@cory", 3)).toBe("Cory - Got it, 3 ahead of this one");
});
