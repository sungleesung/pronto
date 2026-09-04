import { expect, test } from "bun:test";
import { RUNTIME_OUTPUT_SCHEMA, validateRuntimeOutput } from "../../packages/cli/src/runtimes/types";

test("uses a strict Codex-compatible schema while preserving optional output fields", () => {
  expect(RUNTIME_OUTPUT_SCHEMA.required).toEqual([
    "reply",
    "summary",
    "workspaceCandidates",
    "attachmentPath",
  ]);
  expect(validateRuntimeOutput({
    reply: "Done.",
    summary: null,
    workspaceCandidates: null,
  })).toEqual({ reply: "Done." });
  expect(validateRuntimeOutput({
    reply: "Done.",
    summary: "   ",
    workspaceCandidates: null,
  })).toEqual({ reply: "Done." });
});

test("accepts bounded workspace candidates in structured runtime output", () => {
  expect(
    validateRuntimeOutput({
      reply: "Choose one.",
      workspaceCandidates: ["/Users/example/one", "/Users/example/two"],
    }),
  ).toEqual({
    reply: "Choose one.",
    workspaceCandidates: ["/Users/example/one", "/Users/example/two"],
  });
});

test("rejects empty, oversized, or non-string workspace candidate sets", () => {
  expect(validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: [] })).toBeNull();
  expect(
    validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: Array(6).fill("/tmp") }),
  ).toBeNull();
  expect(validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: [42] })).toBeNull();
});

test("accepts an absolute attachment path and refuses anything else", () => {
  expect(validateRuntimeOutput({
    attachmentPath: "/tmp/chart.png",
    reply: "Here it is.",
    summary: null,
    workspaceCandidates: null,
  })).toMatchObject({ attachmentPath: "/tmp/chart.png" });

  // A relative path is not sent — it resolves against the provider's working directory
  // rather than the turn's — but it must not take the reply down with it.
  for (const attachmentPath of ["chart.png", "./chart.png", "../chart.png", "~/chart.png", 42]) {
    const output = validateRuntimeOutput({
      attachmentPath,
      reply: "Here it is.",
      summary: null,
      workspaceCandidates: null,
    });
    expect(output).not.toBeNull();
    expect(output!.reply).toBe("Here it is.");
    expect(output!.attachmentPath).toBeUndefined();
  }

  // Absent and null both mean "no attachment", not a failure.
  for (const attachmentPath of [null, undefined, ""]) {
    expect(validateRuntimeOutput({
      attachmentPath,
      reply: "No file.",
      summary: null,
      workspaceCandidates: null,
    })).toMatchObject({ reply: "No file." });
  }
});
