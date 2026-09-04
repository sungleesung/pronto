/**
 * What someone other than the owner may reach.
 *
 * The owner installed this on their own machine and accepted that it runs commands there.
 * Nobody else agreed to that, and they cannot judge it: a request like "check the shared
 * folder" reads as harmless whether it lands in a project directory or in Downloads next
 * to a bank statement.
 *
 * So guests get an assistant, not a shell. They keep conversation history, message search,
 * the web, and anything reached through MCP — enough to be useful — and lose every tool
 * that touches this machine. This is a capability boundary rather than a prompt
 * instruction, because a prompt is a request and a denied tool is not.
 */
export const GUEST_DENIED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
];

/**
 * Tools denied for a request, given who sent it. The owner is unrestricted; everyone else
 * is bounded. Returns an empty list for the owner so no flag is passed at all, keeping the
 * owner's invocation byte-identical to what it was.
 */
export function deniedToolsFor(input: { readonly fromMe: boolean }): readonly string[] {
  return input.fromMe ? [] : GUEST_DENIED_TOOLS;
}
