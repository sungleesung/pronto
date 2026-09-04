import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivatedRequest } from "../../packages/cli/src/activation";
import { FAILURE_NOTICE, TurnCoordinator, TurnProcessor } from "../../packages/cli/src/core/turn";
import { acknowledgementText } from "../../packages/cli/src/imessage/reply-format";
import type { SendDisposition } from "../../packages/cli/src/imessage/transport";
import { RuntimeChain } from "../../packages/cli/src/runtimes/chain";
import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "../../packages/cli/src/runtimes/types";
import { chatKeyForId } from "../../packages/cli/src/storage/chat-key";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";
import { MemoryStore } from "../../packages/cli/src/storage/memory";
import { promoteWorkspace, WorkspaceStore } from "../../packages/cli/src/storage/workspaces";
import { ConversationBroker, type CurrentChatSource } from "../../packages/cli/src/tools/broker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

class FakeAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/fake";
  readonly inputs: RuntimeInput[] = [];
  onRun?: () => void;
  constructor(
    readonly kind: "codex" | "claude",
    public result: RuntimeAttemptResult,
  ) {}
  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.inputs.push(input);
    this.onRun?.();
    return this.result;
  }
}

class OrderedAdapter implements RuntimeAdapter {
  readonly executablePath = "/usr/local/bin/fake";
  readonly kind = "codex" as const;
  readonly requests: string[] = [];
  #active = 0;
  maxActive = 0;

  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    const request = input.prompt.includes("\nAUTHORIZED REQUEST\nfirst request\n")
      ? "first"
      : "second";
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.#active -= 1;
    return { output: { reply: `${request} reply` }, status: "success", toolActivity: "none" };
  }
}

class FakeTransport {
  readonly sends: Array<{ attachmentPath?: string; chatId: number; text: string }> = [];
  disposition: SendDisposition = { disposition: "confirmed", guid: "OUT-1" };
  async recentMessages(): Promise<unknown[]> {
    return [
      {
        attachments: [{
          available: true,
          mimeType: "application/pdf",
          name: "brief.pdf",
          sizeBytes: 12,
        }],
        fromMe: false,
        kind: "message",
        messageGuid: "RECENT-1",
        occurredAt: "2026-09-01T12:00:00.000Z",
        reaction: null,
        sender: "+15555550100",
        service: "iMessage",
        text: "The launch is Friday.",
        urlPreview: false,
      },
    ];
  }
  readonly acknowledged: Array<{ chatId: number; text: string }> = [];

  async acknowledge(chatId: number, activationTag: string, ahead = 0): Promise<boolean> {
    this.acknowledged.push({ chatId, text: acknowledgementText(activationTag, ahead) });
    return true;
  }

  async sendText(
    chatId: number,
    text: string,
    _conversation?: unknown,
    attachmentPath?: string,
  ): Promise<SendDisposition> {
    this.sends.push({
      ...(attachmentPath === undefined ? {} : { attachmentPath }),
      chatId,
      text,
    });
    return this.disposition;
  }
}

const source: CurrentChatSource = {
  attachment: async () => null,
  details: async () => ({}),
  history: async () => ({ messages: [] }),
  search: async () => ({ hits: [] }),
};

const activation: ActivatedRequest = {
  activationTag: "@helper",
  chatId: 42,
  conversation: {
    chatId: 42,
    expiresAt: "2099-01-01T00:00:00.000Z",
    provider: "apple-messages",
    token: "persisted-conversation-reference",
    version: 1,
  },
  isFromMe: false,
  occurredAt: "2026-09-01T12:00:00.000Z",
  providerGuid: "IN-1",
  sender: "+15555550100",
  request: "Draft the launch note.",
  rowId: 1,
};

async function harness(
  primary: RuntimeAdapter,
  fallback?: RuntimeAdapter,
  maxConcurrentTurns?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-turn-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const journal = new DeliveryJournal(database);
  const memory = new MemoryStore(database);
  const workspaces = new WorkspaceStore(database);
  const transport = new FakeTransport();
  const broker = new ConversationBroker(source);
  const processor = new TurnProcessor({
    bridgeExecutablePath: "/Applications/pronto/bin/pronto",
    broker,
    brokerUrl: "http://127.0.0.1:1",
    journal,
    memory,
    runtimes: new RuntimeChain(primary, fallback),
    transport,
    defaultWorkingDirectory: directory,
    workspaces,
  });
  const salt = "private-installation-salt";
  const coordinator = maxConcurrentTurns === undefined
    ? new TurnCoordinator(processor, journal, salt)
    : new TurnCoordinator(processor, journal, salt, maxConcurrentTurns);
  return {
    close: () => database.close(),
    coordinator,
    database,
    journal,
    memory,
    salt,
    transport,
    workspaces,
    directory,
  };
}

describe("turn lifecycle", () => {
  test("a guest's turn withholds the shell and filesystem; the owner's does not", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "ok" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({
        ...activation, isFromMe: false, providerGuid: "IN-GUEST", request: "check the shared folder",
      });
      await h.coordinator.idle();
      const guest = primary.inputs[0]!.deniedTools ?? [];
      for (const tool of ["Bash", "Read", "Write", "Edit"]) expect(guest).toContain(tool);

      h.coordinator.admit({
        ...activation, isFromMe: true, providerGuid: "IN-OWNER", request: "check the shared folder",
      });
      await h.coordinator.idle();
      // Nothing withheld, and no flag passed at all, so the owner's invocation is unchanged.
      expect(primary.inputs[1]!.deniedTools).toBeUndefined();
    } finally {
      h.close();
    }
  });

  test("a queued request is told how many are ahead of it", async () => {
    const primary = new OrderedAdapter();
    const h = await harness(primary);
    try {
      // Same chat, so they run one at a time and the second genuinely waits.
      h.coordinator.admit({ ...activation, providerGuid: "IN-Q1", request: "first request" });
      h.coordinator.admit({ ...activation, providerGuid: "IN-Q2", request: "second request" });
      await h.coordinator.idle();
      expect(h.transport.acknowledged.map((a) => a.text)).toEqual([
        "Helper - Working on that now",
        "Helper - Got it, finishing one before this",
      ]);
    } finally {
      h.close();
    }
  });

  test("a btw folds into the request it revises and answers once", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Vegetarian version ready." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      // Both arrive before the drain starts the first one, which is the real timing:
      // detection takes long enough that an aside usually lands first.
      h.coordinator.admit({ ...activation, providerGuid: "IN-ORIG", request: "recipe for chicken parm" });
      h.coordinator.admit({ ...activation, providerGuid: "IN-BTW", request: "btw make it vegetarian" });
      await h.coordinator.idle();

      // One model turn, one reply — not two.
      expect(primary.inputs).toHaveLength(1);
      expect(h.transport.sends).toHaveLength(1);

      const prompt = primary.inputs[0]!.prompt;
      expect(prompt).toContain("recipe for chicken parm");
      expect(prompt).toContain("make it vegetarian");
      expect(prompt).toContain("REVISION");

      // The superseded request is kept, settled without a reply.
      expect(h.journal.state("IN-ORIG")).toBe("parked");
    } finally {
      h.close();
    }
  });

  test("a btw with nothing pending stands on its own", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Noted." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-LONE-BTW", request: "btw make it vegetarian" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(1);
      // Nothing to fold into, but it still reads as an amendment rather than a new question.
      expect(primary.inputs[0]!.prompt).toContain("REVISION of the request");
      expect(primary.inputs[0]!.prompt).toContain("make it vegetarian");
      // The heading echoes the person's words, never the scaffolding around them.
      // The heading echoes exactly what was typed, with no scaffolding in it.
      expect(h.transport.sends[0]!.text).toContain("re: \u201cbtw make it vegetarian\u201d");
      expect(h.transport.sends[0]!.text).not.toContain("REVISION");
      expect(h.transport.sends).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  test("a btw does not fold into a request already running", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "done" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-FIRST", request: "recipe for chicken parm" });
      await h.coordinator.idle();
      // The first turn has already been answered, so there is nothing left to revise.
      h.coordinator.admit({ ...activation, providerGuid: "IN-LATE", request: "btw make it vegetarian" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(2);
      expect(h.journal.state("IN-FIRST")).toBe("delivered");
    } finally {
      h.close();
    }
  });

  test("runs turns from different chats at the same time", async () => {
    const primary = new OrderedAdapter();
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-CHAT-A", request: "first request" });
      h.coordinator.admit({
        ...activation,
        chatId: 7,
        conversation: { ...activation.conversation, chatId: 7 },
        providerGuid: "IN-CHAT-B",
        request: "second request",
      });
      await h.coordinator.idle();
      // Two conversations, so neither waits on the other.
      expect(primary.maxActive).toBe(2);
      expect(primary.requests.sort()).toEqual(["first", "second"]);
    } finally {
      h.close();
    }
  });

  test("never exceeds the configured turn concurrency", async () => {
    const primary = new OrderedAdapter();
    const h = await harness(primary, undefined, 2);
    try {
      for (const [index, chatId] of [11, 12, 13, 14].entries()) {
        h.coordinator.admit({
          ...activation,
          chatId,
          conversation: { ...activation.conversation, chatId },
          providerGuid: `IN-CAP-${index}`,
          request: index % 2 === 0 ? "first request" : "second request",
        });
      }
      await h.coordinator.idle();
      expect(primary.maxActive).toBeLessThanOrEqual(2);
      expect(primary.requests).toHaveLength(4);
    } finally {
      h.close();
    }
  });

  test("says it is working on a real turn, but not on the latency probe", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Done." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-ACK", request: "do the thing" });
      await h.coordinator.idle();
      expect(h.transport.acknowledged).toEqual([
        { chatId: 42, text: "Helper - Working on that now" },
      ]);

      h.coordinator.admit({ ...activation, providerGuid: "IN-ACK-PROBE", request: "ping test" });
      await h.coordinator.idle();
      // The probe answers in well under a second, so an acknowledgement would be noise.
      expect(h.transport.acknowledged).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  test("attaches the runtime's file to the first bubble only", async () => {
    const primary = new FakeAdapter("codex", {
      output: { attachmentPath: "/tmp/chart.png", reply: "Here is the chart." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-FILE", request: "chart it" });
      await h.coordinator.idle();
      expect(h.transport.sends).toHaveLength(1);
      expect(h.transport.sends[0]!.attachmentPath).toBe("/tmp/chart.png");
    } finally {
      h.close();
    }
  });

  test("splits a long reply into several bubbles, heading on the first", async () => {
    const paragraph = "y".repeat(900);
    const primary = new FakeAdapter("codex", {
      output: { reply: [paragraph, paragraph, paragraph].join("\n\n") },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-LONG", request: "explain it" });
      await h.coordinator.idle();
      expect(h.transport.sends.length).toBeGreaterThan(1);
      expect(h.transport.sends[0]!.text.startsWith("Helper\nre: \u201cexplain it\u201d")).toBe(true);
      expect(h.transport.sends.slice(1).every((s) => !s.text.includes("re: "))).toBe(true);
      expect(h.transport.sends.every((s) => s.text.length <= 1_300)).toBe(true);
    } finally {
      h.close();
    }
  });

  test("flattens markdown from the runtime before it reaches the chat", async () => {
    const primary = new FakeAdapter("codex", {
      output: {
        reply: "1. **FetishCon** (annual)\n- see [the docs](https://example.com/a)\n`npm run build`",
      },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-MARKDOWN",
        request: "list the events",
      });
      await h.coordinator.idle();
      const sent = h.transport.sends[0]!.text;
      expect(sent).not.toContain("**");
      expect(sent).not.toContain("`");
      expect(sent).not.toContain("](");
      expect(sent).toContain("1. FetishCon (annual)");
      expect(sent).toContain("• see the docs (https://example.com/a)");
      expect(sent).toContain("npm run build");
    } finally {
      h.close();
    }
  });

  test.each([
    ["a participant", false, "IN-ECHO-PARTICIPANT"],
    ["the owner", true, "IN-ECHO-OWNER"],
  ])("echoes the request back when %s sent it", async (_label, isFromMe, guid) => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "On it." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({
        ...activation,
        isFromMe,
        providerGuid: guid,
        request: "check the deploy",
      });
      await h.coordinator.idle();
      expect(h.transport.sends).toHaveLength(1);
      expect(h.transport.sends[0]!.text).toBe(
        "Helper\nre: \u201ccheck the deploy\u201d\n\nOn it.",
      );
    } finally {
      h.close();
    }
  });

  test("answers the latency probe from the journal without running a model turn", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "should never be produced" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit({
        ...activation,
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
        providerGuid: "IN-PROBE",
        request: "ping test",
      });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends).toHaveLength(1);
      const sent = h.transport.sends[0]!.text;
      expect(sent).toContain("Helper\nre: \u201cping test\u201d");
      expect(sent).toContain("Latency for this message:");
      expect(sent).toContain("detect");
      expect(sent).toContain("handle");
      expect(sent).not.toContain("should never be produced");
    } finally {
      h.close();
    }
  });

  test("switches only on explicit intent and makes the folder durable after delivery", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Working there." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const project = join(h.directory, "Project With Spaces");
    await mkdir(project);
    const canonical = await realpath(project);
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-SWITCH",
        request: `work in "${project}" and inspect it`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(canonical);
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBe(canonical);

      primary.result = {
        output: { reply: "Mention handled." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-MENTION",
        request: `summarize files in ${h.directory}`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(canonical);
    } finally {
      h.close();
    }
  });

  test("keeps an explicit switch temporary when delivery is ambiguous", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Working there." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const project = join(h.directory, "project-a");
    await mkdir(project);
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-AMBIGUOUS-SWITCH",
        request: `switch to ${project}`,
      });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();
    } finally {
      h.close();
    }
  });

  test("rejects negated, relative, and multi-path switch requests", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "No switch." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const first = join(h.directory, "first-project");
    const second = join(h.directory, "second-project");
    await mkdir(first);
    await mkdir(second);
    try {
      for (const [index, request] of [
        `don't use ${first}`,
        'use "first-project"',
        `use ${first} and compare ${second}`,
      ].entries()) {
        h.coordinator.admit({
          ...activation,
          providerGuid: `IN-NO-SWITCH-${index}`,
          request,
        });
        await h.coordinator.idle();
        expect(primary.inputs[index]!.workingDirectory).toBe(await realpath(h.directory));
      }
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();
    } finally {
      h.close();
    }
  });

  test("publishes numbered discovery candidates and switches on the next confirmation", async () => {
    const h = await harness(
      new FakeAdapter("codex", {
        output: { reply: "I found these projects.", workspaceCandidates: [] },
        status: "success",
        toolActivity: "none",
      }),
    );
    const primary = h.coordinator.processor.dependencies.runtimes.primary as FakeAdapter;
    const first = join(h.directory, "first");
    const second = join(h.directory, "second");
    await mkdir(first);
    await mkdir(second);
    primary.result = {
      output: { reply: "I found these projects.", workspaceCandidates: [first, second] },
      status: "success",
      toolActivity: "none",
    };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-DISCOVER", request: "find my app" });
      await h.coordinator.idle();
      expect(h.transport.sends[0]!.text).toContain(`2. ${await realpath(second)}`);
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBeNull();

      primary.result = {
        output: { reply: "Switched." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({ ...activation, providerGuid: "IN-CONFIRM", request: "2" });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(await realpath(second));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).activeDirectory).toBe(
        await realpath(second),
      );
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("does not promote undelivered candidates or expose them to another chat", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Choose this project." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const candidate = join(h.directory, "candidate");
    await mkdir(candidate);
    primary.result = {
      output: { reply: "Choose this project.", workspaceCandidates: [candidate] },
      status: "success",
      toolActivity: "none",
    };
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-AMBIGUOUS-DISCOVERY" });
      await h.coordinator.idle();
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);

      h.transport.disposition = { disposition: "confirmed", guid: "OUT-OTHER" };
      promoteWorkspace(h.database, {
        candidates: [await realpath(candidate)],
        chatKey: chatKeyForId(42, h.salt),
      });
      primary.result = {
        output: { reply: "Other chat stayed put." },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        chatId: 99,
        conversation: { ...activation.conversation, chatId: 99 },
        providerGuid: "IN-OTHER-CHAT",
        request: "1",
      });
      await h.coordinator.idle();
      expect(primary.inputs[1]!.workingDirectory).toBe(await realpath(h.directory));
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([
        await realpath(candidate),
      ]);
    } finally {
      h.close();
    }
  });

  test("persists only displayed candidates and bounds the composed reply", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "x".repeat(4_000) },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const valid = join(h.directory, "valid-project");
    await mkdir(valid);
    try {
      primary.result = {
        output: {
          reply: "x".repeat(4_000),
          workspaceCandidates: [join(h.directory, "missing"), valid],
        },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({ ...activation, providerGuid: "IN-BOUNDED", request: "find it" });
      await h.coordinator.idle();

      // A reply this long is delivered as several bubbles; the bound applies to each.
      const composed = h.transport.sends.map((send) => send.text).join("\n\n");
      expect(h.transport.sends.every((send) => send.text.length <= 4_000)).toBe(true);
      expect(composed).toContain(`1. ${await realpath(valid)}`);
      expect(composed).not.toContain("missing");
      const firstTurnSends = h.transport.sends.length;
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([
        await realpath(valid),
      ]);

      primary.result = {
        output: {
          reply: "No valid projects.",
          workspaceCandidates: [join(h.directory, "still-missing")],
        },
        status: "success",
        toolActivity: "none",
      };
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-INVALID-CANDIDATES",
        request: "find it again",
      });
      await h.coordinator.idle();
      expect(
        h.transport.sends.slice(firstTurnSends).map((send) => send.text).join("\n\n"),
      ).toBe("Helper\nre: \u201cfind it again\u201d\n\nNo valid projects.");
      expect(h.workspaces.get(chatKeyForId(42, h.salt)).pendingCandidates).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("promotes an explicit switch and displayed discovery candidates together", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Switched and found another." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const active = join(h.directory, "active");
    const candidate = join(h.directory, "candidate");
    await mkdir(active);
    await mkdir(candidate);
    primary.result = {
      output: { reply: "Switched and found another.", workspaceCandidates: [candidate] },
      status: "success",
      toolActivity: "none",
    };
    try {
      h.coordinator.admit({
        ...activation,
        providerGuid: "IN-SWITCH-DISCOVER",
        request: `use ${active} and find my other project`,
      });
      await h.coordinator.idle();
      expect(h.workspaces.get(chatKeyForId(42, h.salt))).toEqual({
        activeDirectory: await realpath(active),
        pendingCandidates: [await realpath(candidate)],
      });
    } finally {
      h.close();
    }
  });

  test("keeps pending confirmation replayable across a tool-free restart", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Switched after restart." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const candidate = join(h.directory, "candidate");
    await mkdir(candidate);
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { candidates: [await realpath(candidate)], chatKey });
    try {
      h.journal.admit({
        chatId: 42,
        chatKey,
        providerGuid: "IN-PENDING-RESTART",
        request: "1",
      });
      const lease = h.journal.lease("IN-PENDING-RESTART")!;
      h.journal.beginRuntimeAttempt("IN-PENDING-RESTART", lease);
      h.journal.recordToolActivity("IN-PENDING-RESTART", lease, "none");

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(candidate));
      expect(h.workspaces.get(chatKey).activeDirectory).toBe(await realpath(candidate));
    } finally {
      h.close();
    }
  });

  test("names the exact unusable workspace and does not invoke a runtime", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const active = join(h.directory, "active");
    const stale = join(h.directory, "deleted-candidate");
    await mkdir(active);
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { chatKey, workingDirectory: await realpath(active) });
    promoteWorkspace(h.database, { candidates: [stale], chatKey });
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-STALE", request: "1" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends[0]!.text).toContain(stale);
      expect(h.transport.sends[0]!.text).not.toContain(
        `couldn't use the folder ${await realpath(active)}`,
      );
      expect(h.workspaces.get(chatKey)).toEqual({
        activeDirectory: await realpath(active),
        pendingCandidates: [],
      });
    } finally {
      h.close();
    }
  });

  test("reports a missing stored active workspace with recovery guidance", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    const missing = join(h.directory, "deleted-active");
    const chatKey = chatKeyForId(42, h.salt);
    promoteWorkspace(h.database, { chatKey, workingDirectory: missing });
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-MISSING-ACTIVE" });
      await h.coordinator.idle();
      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends[0]!.text).toContain(missing);
      expect(h.transport.sends[0]!.text).toContain("use /path/to/project");
      expect(h.transport.sends[0]!.text).toContain("pronto forget");
    } finally {
      h.close();
    }
  });

  test("delivers one primary reply and promotes only confirmed output", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Launch note ready.", summary: "Planning a Friday launch." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      expect(h.coordinator.admit(activation)).toBe("accepted");
      expect(h.coordinator.admit(activation)).toBe("duplicate");
      await h.coordinator.idle();

      expect(h.transport.sends).toEqual([
        { chatId: 42, text: "Helper\nre: \u201cDraft the launch note.\u201d\n\nLaunch note ready." },
      ]);
      expect(h.journal.state("IN-1")).toBe("delivered");
      expect(h.memory.get(chatKeyForId(42, h.salt))).toEqual({
        exchanges: [{ reply: "Launch note ready.", request: "Draft the launch note." }],
        summary: "Planning a Friday launch.",
      });
      expect(primary.inputs[0]!.prompt).toContain("The launch is Friday.");
      expect(primary.inputs[0]!.prompt).toContain("AUTHORIZED REQUEST");
      expect(primary.inputs[0]!.prompt).toContain("iMessage or RCS conversation");
    } finally {
      h.close();
    }
  });

  test("uses a fresh capability with byte-identical context for safe fallback", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "offline",
      status: "operational-failure",
      toolActivity: "none",
    });
    const fallback = new FakeAdapter("claude", {
      output: { reply: "Fallback reply." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary, fallback);
    const project = join(h.directory, "fallback-project");
    await mkdir(project);
    try {
      const fallbackToolActivity: { value: number | null } = { value: null };
      fallback.onRun = () => {
        const row = h.database
          .query("SELECT tool_activity FROM delivery_events WHERE provider_guid = ?")
          .get("IN-1") as { tool_activity: number | null };
        fallbackToolActivity.value = row.tool_activity;
      };
      h.coordinator.admit({ ...activation, request: `use ${project}` });
      await h.coordinator.idle();
      expect(primary.inputs[0]!.prompt).toBe(fallback.inputs[0]!.prompt);
      expect(primary.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(fallback.inputs[0]!.workingDirectory).toBe(await realpath(project));
      expect(primary.inputs[0]!.capability).not.toBe(fallback.inputs[0]!.capability);
      expect(fallbackToolActivity.value).toBe(2);
      expect(h.transport.sends).toHaveLength(1);
      expect(
        h.database
          .query("SELECT runtime_kind, outcome FROM runtime_attempts ORDER BY id")
          .all(),
      ).toEqual([
        { outcome: "operational-failure", runtime_kind: "codex" },
        { outcome: "success", runtime_kind: "claude" },
      ]);
    } finally {
      h.close();
    }
  });

  test("parks unknown side effects silently without fallback", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "timeout",
      status: "operational-failure",
      toolActivity: "unknown",
    });
    const fallback = new FakeAdapter("claude", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary, fallback);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.journal.state("IN-1")).toBe("parked");
      expect(fallback.inputs).toHaveLength(0);
      expect(h.transport.sends).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  test("sends one content-free notice after definitive runtime failure", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "permission-denial",
      status: "application-failure",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.transport.sends).toEqual([
        { chatId: 42, text: `Helper\nre: \u201cDraft the launch note.\u201d\n\n${FAILURE_NOTICE}` },
      ]);
      expect(h.memory.get(chatKeyForId(42, h.salt)).exchanges).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("sends a failure notice for invalid output even after read-only tool activity", async () => {
    const primary = new FakeAdapter("codex", {
      reason: "invalid-output",
      status: "application-failure",
      toolActivity: "observed",
    });
    const h = await harness(primary);
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.transport.sends).toEqual([
        { chatId: 42, text: `Helper\nre: \u201cDraft the launch note.\u201d\n\n${FAILURE_NOTICE}` },
      ]);
      expect(h.journal.state("IN-1")).toBe("delivered");
    } finally {
      h.close();
    }
  });

  test("parks an uncertain send and never promotes it", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "Possibly sent." },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    h.transport.disposition = { disposition: "ambiguous" };
    try {
      h.coordinator.admit(activation);
      await h.coordinator.idle();
      expect(h.journal.state("IN-1")).toBe("ambiguous");
      expect(h.memory.get(chatKeyForId(42, h.salt)).exchanges).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("processes admitted work through one global FIFO worker", async () => {
    const primary = new OrderedAdapter();
    const h = await harness(primary);
    try {
      h.coordinator.admit({ ...activation, providerGuid: "IN-1", request: "first request" });
      h.coordinator.admit({ ...activation, providerGuid: "IN-2", request: "second request" });
      await h.coordinator.idle();
      expect(primary.requests).toEqual(["first", "second"]);
      expect(primary.maxActive).toBe(1);
      expect(h.transport.sends.map((send) => send.text)).toEqual([
        "Helper\nre: \u201cfirst request\u201d\n\nfirst reply",
        "Helper\nre: \u201csecond request\u201d\n\nsecond reply",
      ]);
    } finally {
      h.close();
    }
  });

  test("resumes an accepted reply after restart without rerunning the agent", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.journal.admit({
        activationTag: "@plan",
        chatId: 42,
        chatKey: chatKeyForId(42, h.salt),
        conversation: activation.conversation,
        providerGuid: "IN-RECOVER",
        request: "recover me",
      });
      const lease = h.journal.lease("IN-RECOVER")!;
      h.journal.accept("IN-RECOVER", lease, { reply: "already accepted" });

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends).toEqual([
        { chatId: 42, text: "Plan\nre: \u201crecover me\u201d\n\nalready accepted" },
      ]);
      expect(h.journal.state("IN-RECOVER")).toBe("delivered");
    } finally {
      h.close();
    }
  });

  test("fails a legacy accepted reply without marking an unattempted send ambiguous", async () => {
    const primary = new FakeAdapter("codex", {
      output: { reply: "must not run" },
      status: "success",
      toolActivity: "none",
    });
    const h = await harness(primary);
    try {
      h.journal.admit({
        activationTag: "@plan",
        chatId: 42,
        chatKey: chatKeyForId(42, h.salt),
        providerGuid: "IN-LEGACY-RECOVER",
        request: "recover me",
      });
      const lease = h.journal.lease("IN-LEGACY-RECOVER")!;
      h.journal.accept("IN-LEGACY-RECOVER", lease, { reply: "already accepted" });

      expect(h.coordinator.start()).toEqual({ ambiguous: 0, parked: 0, resumed: 1 });
      await h.coordinator.idle();

      expect(primary.inputs).toHaveLength(0);
      expect(h.transport.sends).toEqual([]);
      expect(h.journal.state("IN-LEGACY-RECOVER")).toBe("failed");
    } finally {
      h.close();
    }
  });
});
