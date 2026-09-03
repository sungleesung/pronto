/**
 * A long answer arrives in Messages as one unbroken bubble, which is the worst shape for
 * a recipe, a list, or anything with steps. Splitting on the structure the text already
 * has — blank lines first, then single lines — keeps related lines together instead of
 * cutting mid-thought.
 *
 * Hard wrapping is the last resort and only happens when a single line is itself longer
 * than a bubble.
 */

export const MAX_BUBBLE_CHARACTERS = 1_200;

function hardWrap(value: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    // Prefer a space near the limit so a word is not cut in half.
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf(" ");
    const cut = breakAt > limit * 0.6 ? breakAt : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/** Groups blocks into bubbles, never exceeding the limit, joining with `separator`. */
function pack(blocks: readonly string[], limit: number, separator: string): string[] {
  const bubbles: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current === "") {
      current = block;
      continue;
    }
    const combined = `${current}${separator}${block}`;
    if (combined.length <= limit) current = combined;
    else {
      bubbles.push(current);
      current = block;
    }
  }
  if (current !== "") bubbles.push(current);
  return bubbles;
}

export function splitReplyText(text: string, limit = MAX_BUBBLE_CHARACTERS): string[] {
  const trimmed = text.trimEnd();
  if (trimmed === "") return [];
  if (trimmed.length <= limit) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/u).map((block) => block.trim()).filter((b) => b !== "");
  const bubbles: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      bubbles.push(paragraph);
      continue;
    }
    // Too big as one block: fall to line boundaries, then to hard wrapping.
    const lines = paragraph.split("\n");
    const packedLines = pack(lines, limit, "\n");
    for (const line of packedLines) {
      if (line.length <= limit) bubbles.push(line);
      else bubbles.push(...hardWrap(line, limit));
    }
  }

  // Recombine adjacent paragraphs that still fit together, so a long reply does not
  // become one bubble per paragraph.
  return pack(bubbles, limit, "\n\n");
}
