import { findTagRanges } from "../activation";
import { plainTextFromMarkdown } from "./plain-text";

/**
 * The Messages bridge sends plain text. The reply opens with three stacked lines:
 * the tag's own name, the echoed request, then the answer. Separate lines rather than
 * one run-on heading, so the eye can skip the first two and land on the reply.
 */
export function formatImessageReplyText(
  activationTag: string,
  replyText: string,
  request?: string,
): string {
  const heading = replyHeading(activationTag, request);
  const body = plainTextFromMarkdown(replyText);
  return body === "" ? heading : `${heading}\n${body}`;
}

/**
 * Sent as soon as a tagged request is picked up. A turn takes tens of seconds and
 * nothing else in the chat says the message was seen, so this is the only signal
 * until the answer lands.
 */
export function acknowledgementText(activationTag: string): string {
  return `${displayName(activationTag)} - Working on that now`;
}

export function imessageReplyBodyCharacterLimit(
  activationTag: string,
  totalCharacterLimit: number,
  request?: string,
): number {
  return Math.max(0, totalCharacterLimit - replyHeading(activationTag, request).length - 1);
}

const REQUEST_ECHO_CHARACTER_LIMIT = 40;

function displayName(activationTag: string): string {
  return titleCase(activationTag.startsWith("@") ? activationTag.slice(1) : activationTag);
}

function replyHeading(activationTag: string, request?: string): string {
  const name = displayName(activationTag);
  const echo = requestEcho(request, activationTag);
  return echo === null ? name : `${name}\nre: ${echo}`;
}

// Echoes the triggering request so a reply stays legible in a fast-moving chat.
// Any activation tag is removed first: the echo ships inside our own outbound
// message, and leaving the tag intact would re-trigger the listener on itself.
function requestEcho(request: string | undefined, activationTag: string): string | null {
  if (request === undefined) return null;
  let stripped = request;
  for (const [start, end] of [...findTagRanges(request, activationTag)].reverse()) {
    stripped = `${stripped.slice(0, start)}${stripped.slice(end)}`;
  }
  const collapsed = plainTextFromMarkdown(stripped).replace(/\s+/gu, " ").trim();
  if (collapsed === "") return null;
  const characters = [...collapsed];
  return characters.length <= REQUEST_ECHO_CHARACTER_LIMIT
    ? `\u201c${collapsed}\u201d`
    : `\u201c${characters.slice(0, REQUEST_ECHO_CHARACTER_LIMIT).join("").trimEnd()}\u2026\u201d`;
}

function titleCase(value: string): string {
  const [first = "", ...rest] = [...value];
  return `${first.toUpperCase()}${rest.join("")}`;
}
