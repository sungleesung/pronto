import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatLatencyReport,
  isLatencyProbe,
} from "../../packages/cli/src/core/latency-probe";

describe("isLatencyProbe", () => {
  test("matches the probe regardless of case and internal spacing", () => {
    expect(isLatencyProbe("ping test")).toBe(true);
    expect(isLatencyProbe("  PING   Test  ")).toBe(true);
    expect(isLatencyProbe("Ping\nTest")).toBe(true);
  });

  test("does not match neighbouring requests", () => {
    expect(isLatencyProbe("ping")).toBe(false);
    expect(isLatencyProbe("ping testing")).toBe(false);
    expect(isLatencyProbe("test ping")).toBe(false);
    expect(isLatencyProbe("ping test the deploy")).toBe(false);
  });
});

describe("formatDuration", () => {
  test("renders sub-minute durations in tenths", () => {
    expect(formatDuration(300)).toBe("0.3s");
    expect(formatDuration(20_291)).toBe("20.3s");
    expect(formatDuration(59_949)).toBe("59.9s");
  });

  test("rolls over to minutes", () => {
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(64_000)).toBe("1m04s");
    expect(formatDuration(119_600)).toBe("2m00s");
  });

  test("clamps a negative duration rather than printing a minus sign", () => {
    expect(formatDuration(-5_000)).toBe("0.0s");
  });
});

describe("formatLatencyReport", () => {
  test("splits the round trip into transport and handling", () => {
    const report = formatLatencyReport({
      admittedAt: 1_000_000 + 5_200,
      now: 1_000_000 + 5_500,
      occurredAt: 1_000_000,
      recentTurnDurations: [20_291, 36_981, 16_794],
    });
    expect(report).toContain("detect   5.2s");
    expect(report).toContain("handle   0.3s");
    expect(report).toContain("total    5.5s");
    expect(report).toContain("Model half, last 3:");
    expect(report).toContain("median 20.3s");
  });

  test("reports detection as unavailable when Messages gave no timestamp", () => {
    const report = formatLatencyReport({
      admittedAt: 1_000_000,
      now: 1_000_400,
      recentTurnDurations: [],
    });
    expect(report).toContain("detect   unavailable");
    expect(report).toContain("handle   0.4s");
    expect(report).not.toContain("Model half");
  });

  test("averages an even-length sample for the median", () => {
    const report = formatLatencyReport({
      admittedAt: 10,
      now: 20,
      occurredAt: 0,
      recentTurnDurations: [10_000, 20_000],
    });
    expect(report).toContain("median 15.0s");
  });
});
