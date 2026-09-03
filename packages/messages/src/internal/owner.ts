/**
 * Which handles belong to the account owner, and therefore whether a conversation could
 * be one the owner is having with themselves.
 *
 * This exists because per-chat routing cannot answer the question: `account_login` is the
 * same address on every chat, while a self-chat's participant may be a different handle
 * of the owner's. Only the account listing carries both.
 */

/** Account logins are prefixed by kind: "E:someone@example.com", "P:+15551234567". */
function stripLoginPrefix(login: string): string {
  return /^[A-Za-z]:/u.test(login) ? login.slice(2) : login;
}

export function ownerHandlesFromAccountListing(value: unknown): Set<string> {
  const handles = new Set<string>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return handles;
  const accounts = (value as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return handles;
  for (const raw of accounts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const login = (raw as { login?: unknown }).login;
    if (typeof login !== "string") continue;
    const handle = stripLoginPrefix(login).trim();
    if (handle !== "") handles.add(handle);
  }
  return handles;
}

/**
 * True unless we can positively prove otherwise. A mirror duplicates the owner's own
 * message, so it can only happen where the owner is a participant. Anything unknown —
 * no routing, no participants, no owner handles — answers true, which keeps the existing
 * behaviour rather than guessing.
 */
export function selfChatMirrorPossible(
  participants: readonly string[] | undefined,
  owners: ReadonlySet<string>,
): boolean {
  if (participants === undefined || participants.length === 0) return true;
  if (owners.size === 0) return true;
  return participants.some((handle) => owners.has(handle));
}
