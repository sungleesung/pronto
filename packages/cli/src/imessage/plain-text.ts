/**
 * Messages renders nothing: a reply containing Markdown arrives with its punctuation
 * intact, so "**FetishCon**" is what the chat actually sees. Runtimes emit Markdown
 * regardless of the prompt asking for plain text, so flatten it at the send boundary
 * where every reply passes through exactly once.
 *
 * Conversion is deliberately conservative. Prose punctuation must survive: an asterisk
 * used for multiplication, and underscores in snake_case identifiers and file paths, are
 * far more common in this agent's replies than single-marker emphasis. Only unambiguous
 * markers are removed.
 */

/** Fenced blocks first, so markers inside them are never treated as emphasis. */
function stripFences(value: string): string {
  return value.replace(/```[^\n`]*\n?([\s\S]*?)```/gu, (_match, body: string) =>
    body.replace(/\n$/u, ""),
  );
}

export function plainTextFromMarkdown(value: string): string {
  let text = stripFences(value);

  // `code` -> code. Backticks never carry meaning in a chat bubble.
  text = text.replace(/`([^`\n]+)`/gu, "$1");

  // ![alt](url) -> alt, before links so the leading "!" cannot survive.
  text = text.replace(/!\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/gu, "$1");

  // [text](url) -> "text (url)", keeping the destination because a bare URL is tappable.
  text = text.replace(
    /\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/gu,
    (_match, label: string, url: string) => {
      const trimmed = label.trim();
      return trimmed === "" || trimmed === url ? url : `${trimmed} (${url})`;
    },
  );

  // Bold before italic so ***both*** collapses cleanly.
  text = text.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/gu, "$1");
  text = text.replace(/__(\S(?:[^_]*\S)?)__/gu, "$1");
  text = text.replace(/~~(\S(?:[^~]*\S)?)~~/gu, "$1");

  // Single-asterisk emphasis only when the markers hug the text: "2 * 3" is untouched.
  text = text.replace(/\*(\S(?:[^*\n]*\S)?)\*/gu, "$1");
  // Single-underscore emphasis is NOT stripped: snake_case would lose its underscores.

  // Leading block markers, per line.
  text = text.replace(/^[^\S\n]{0,3}#{1,6}[^\S\n]+/gmu, "");
  text = text.replace(/^[^\S\n]*>[^\S\n]?/gmu, "");
  text = text.replace(/^([^\S\n]*)[-*+][^\S\n]+/gmu, "$1• ");

  return text;
}
