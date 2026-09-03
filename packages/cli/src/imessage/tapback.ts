import type { TapbackReaction } from "pronto-imessage";

/**
 * Messages supports exactly six tapbacks. There is no checkmark, so "like" (a thumbs up)
 * is the closest available "received, working on it" for a request acknowledgement.
 * Override with PRONTO_RECEIPT_REACTION.
 *
 * This is vocabulary, not provider mechanics: sending the tapback belongs to
 * pronto-imessage, and only the naming and validation live here.
 */
export const TAPBACK_REACTIONS: readonly TapbackReaction[] = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasis",
  "question",
];

export const DEFAULT_RECEIPT_REACTION: TapbackReaction = "like";

export function isTapbackReaction(value: unknown): value is TapbackReaction {
  return typeof value === "string" && (TAPBACK_REACTIONS as readonly string[]).includes(value);
}
