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

// Code is lifted out before anything else runs and put back untouched at the end.
// Stripping the fence or the backticks first would leave the code exposed to the
// emphasis rules below, and "def f(*args, **kwargs)" would come out as
// "def f(args, *kwargs)" — silently corrupted rather than merely unformatted.
const PLACEHOLDER = "\u0000";

function liftCode(value: string): { readonly bodies: string[]; readonly text: string } {
  const bodies: string[] = [];
  const hold = (body: string): string => {
    bodies.push(body);
    return `${PLACEHOLDER}${bodies.length - 1}${PLACEHOLDER}`;
  };
  const withoutFences = value.replace(
    /```[^\n`]*\n?([\s\S]*?)```/gu,
    (_match, body: string) => hold(body.replace(/\n$/u, "")),
  );
  return {
    bodies,
    text: withoutFences.replace(/`([^`\n]+)`/gu, (_match, body: string) => hold(body)),
  };
}

function restoreCode(value: string, bodies: readonly string[]): string {
  return value.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "gu"),
    (match, index: string) => bodies[Number(index)] ?? match,
  );
}

export function plainTextFromMarkdown(value: string): string {
  const lifted = liftCode(value);
  let text = lifted.text;

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

  // Single-asterisk emphasis, and only at a word boundary. Markers hugging the text is
  // not enough on its own: "2*3*4" would otherwise collapse to "234".
  text = text.replace(
    /(^|[^\p{L}\p{N}_*])\*(\S(?:[^*\n]*\S)?)\*(?![\p{L}\p{N}_])/gmu,
    "$1$2",
  );
  // Single-underscore emphasis is NOT stripped: snake_case would lose its underscores.

  // Leading block markers, per line.
  text = text.replace(/^[^\S\n]{0,3}#{1,6}[^\S\n]+/gmu, "");
  text = text.replace(/^[^\S\n]*>[^\S\n]?/gmu, "");
  text = text.replace(/^([^\S\n]*)[-*+][^\S\n]+/gmu, "$1• ");

  return restoreCode(text, lifted.bodies);
}
