/**
 * Who is allowed to instruct the agent.
 *
 * The trigger tag is not authentication: anyone in an eligible conversation can reach an
 * agent that runs commands on this Mac. That is a defensible default for a machine's owner
 * and an indefensible one for anybody else, so the choice is explicit and the safe option
 * is the one that requires no thought.
 */

export type AccessPolicy =
  | { readonly mode: "everyone" }
  | { readonly handles: readonly string[]; readonly mode: "allowlist" };

/**
 * Handles arrive in whatever shape Messages recorded them: "+18184001133", "8184001133",
 * "(818) 400-1133", "Name@Example.com". Compare on a canonical form so a list entry
 * matches the same person however they were saved.
 *
 * Phone numbers reduce to their last ten digits, which is what survives country-code and
 * punctuation differences without pretending to be a real phone-number parser.
 */
export function canonicalHandle(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return "";
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/gu, "");
  if (digits === "") return trimmed;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isAccessPolicy(value: unknown): value is AccessPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as { handles?: unknown; mode?: unknown };
  if (policy.mode === "everyone") return true;
  return policy.mode === "allowlist" &&
    Array.isArray(policy.handles) &&
    policy.handles.every((handle) => typeof handle === "string");
}

/**
 * Messages the owner sent are always allowed: they are the person who installed this.
 * Everything else is judged against the policy, and an unknown sender under an allowlist
 * is refused rather than guessed at.
 */
export function senderAllowed(
  policy: AccessPolicy,
  input: { readonly fromMe: boolean; readonly sender: string | null },
): boolean {
  if (input.fromMe) return true;
  if (policy.mode === "everyone") return true;
  if (input.sender === null) return false;
  const sender = canonicalHandle(input.sender);
  if (sender === "") return false;
  return policy.handles.some((handle) => canonicalHandle(handle) === sender);
}
