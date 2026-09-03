import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";

test("an ambiguous delivery resolves once our own message is observed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-ambiguous-"));
  try {
    const database = openProntoDatabase(join(directory, "state.sqlite"));
    const journal = new DeliveryJournal(database);
    journal.admit({ chatId: 42, chatKey: "chat-key", providerGuid: "IN-1", request: "hello" });
    const lease = journal.lease("IN-1")!;
    journal.accept("IN-1", lease, { reply: "the reply" });
    journal.beginSend("IN-1", lease, 42, "the reply");
    journal.markAmbiguous("IN-1", lease);
    expect(journal.state("IN-1")).toBe("ambiguous");

    // The watcher sees our own outbound text echoed back by Messages.
    expect(journal.matchesOutboundEcho(42, "the reply")).toBe(true);
    expect(journal.state("IN-1")).toBe("delivered");

    // The fingerprint is consumed, so a repeat does not match again.
    expect(journal.matchesOutboundEcho(42, "the reply")).toBe(false);
    database.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
