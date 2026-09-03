/**
 * A self-diagnosing probe for the round trip.
 *
 * The tagged request "ping test" short-circuits the runtime: no model turn runs, so the
 * numbers it reports isolate the transport. That matters because the two halves of the
 * round trip have very different causes and only one of them is the model's fault.
 */

const PROBE_REQUEST = "ping test";

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function isLatencyProbe(request: string): boolean {
  return normalize(request) === PROBE_REQUEST;
}

/** Milliseconds as a compact human duration: "0.3s", "20.7s", "1m04s". */
export function formatDuration(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds);
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`;
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.round((clamped % 60_000) / 1000);
  return seconds === 60
    ? `${minutes + 1}m00s`
    : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function formatLatencyReport(input: {
  readonly admittedAt?: number;
  readonly now: number;
  readonly occurredAt?: number;
  readonly recentTurnDurations: readonly number[];
}): string {
  const lines: string[] = ["Latency for this message:"];

  // Messages recorded the text -> we opened a delivery row. Provider + watcher time.
  const detect = input.occurredAt !== undefined && input.admittedAt !== undefined
    ? input.admittedAt - input.occurredAt
    : null;
  // Our own queue and compose time, up to the moment this text was built.
  const handle = input.admittedAt !== undefined ? input.now - input.admittedAt : null;
  const total = input.occurredAt !== undefined ? input.now - input.occurredAt : null;

  lines.push(
    detect === null
      ? "  detect   unavailable (no timestamp from Messages)"
      : `  detect   ${formatDuration(detect)}  Messages to queue`,
  );
  if (handle !== null) lines.push(`  handle   ${formatDuration(handle)}  queue to this reply`);
  if (total !== null) lines.push(`  total    ${formatDuration(total)}`);

  lines.push("", "No model turn ran for this probe, so that is the transport floor.");

  const durations = input.recentTurnDurations;
  if (durations.length > 0) {
    const middle = median(durations);
    const listed = durations.map((value) => formatDuration(value)).join(" · ");
    lines.push(
      `Model half, last ${durations.length}: ${listed}` +
        (middle === null ? "" : ` (median ${formatDuration(middle)})`),
    );
  }

  return lines.join("\n");
}
