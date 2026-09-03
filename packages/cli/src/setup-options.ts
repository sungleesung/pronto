import { normalizeTags } from "./config";
import type { AccessPolicy } from "./access";

/**
 * Answers supplied on the command line instead of at a prompt.
 *
 * Setup is a conversation by default, which is right for a terminal and wrong for an
 * installer that already asked the same questions in its own interface. Every field is
 * optional and simply pre-answers one prompt, so a partly-specified run still asks for the
 * rest and there is only ever one code path doing the installing.
 */
export interface SetupOptions {
  readonly access?: AccessPolicy;
  readonly acceptTrust: boolean;
  readonly fallback?: boolean;
  readonly runtime?: "codex" | "claude";
  readonly tags?: readonly string[];
  readonly workingDirectory?: string;
}

function valueFor(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

export function parseSetupOptions(argv: readonly string[]): SetupOptions {
  let acceptTrust = false;
  let access: AccessPolicy | undefined;
  const allow: string[] = [];
  let mode: "allowlist" | "everyone" | undefined;
  let fallback: boolean | undefined;
  let runtime: "codex" | "claude" | undefined;
  let tags: readonly string[] | undefined;
  let workingDirectory: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    switch (flag) {
      case "--accept-trust":
        acceptTrust = true;
        break;
      case "--allow":
        allow.push(valueFor(argv, index, flag));
        index += 1;
        break;
      case "--access": {
        const value = valueFor(argv, index, flag);
        if (value !== "everyone" && value !== "allowlist") {
          throw new Error("--access must be everyone or allowlist");
        }
        mode = value;
        index += 1;
        break;
      }
      case "--fallback":
        fallback = true;
        break;
      case "--no-fallback":
        fallback = false;
        break;
      case "--runtime": {
        const value = valueFor(argv, index, flag);
        if (value !== "codex" && value !== "claude") {
          throw new Error("--runtime must be codex or claude");
        }
        runtime = value;
        index += 1;
        break;
      }
      case "--tag":
        tags = normalizeTags(valueFor(argv, index, flag).split(",").map((tag) => tag.trim()));
        index += 1;
        break;
      case "--working-directory":
        workingDirectory = valueFor(argv, index, flag);
        index += 1;
        break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown setup option ${flag}`);
    }
  }

  if (mode === "allowlist") access = { handles: allow, mode: "allowlist" };
  else if (mode === "everyone") access = { mode: "everyone" };
  else if (allow.length > 0) access = { handles: allow, mode: "allowlist" };

  return {
    ...(access === undefined ? {} : { access }),
    acceptTrust,
    ...(fallback === undefined ? {} : { fallback }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(tags === undefined ? {} : { tags }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}
