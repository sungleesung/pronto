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

  // Relative paths resolve against the provider's cwd, not the turn's working
  // directory, so accepting one would silently send the wrong file.
  for (const attachmentPath of ["chart.png", "./chart.png", "../chart.png", "~/chart.png"]) {
    expect(validateRuntimeOutput({
      attachmentPath,
      reply: "Here it is.",
      summary: null,
      workspaceCandidates: null,
    })).toBeNull();
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
