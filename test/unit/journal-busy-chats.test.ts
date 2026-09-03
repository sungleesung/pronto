import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import { DeliveryJournal } from "../../packages/cli/src/storage/journal";

test("nextRunnable skips busy chats and binds every placeholder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-busy-"));
  try {
    const database = openProntoDatabase(join(directory, "state.sqlite"));
    const journal = new DeliveryJournal(database);
    for (const [guid, chatKey, chatId] of [
      ["IN-A", "key-a", 1],
      ["IN-B", "key-b", 2],
      ["IN-C", "key-c", 3],
    ] as const) {
      journal.admit({ chatId, chatKey, providerGuid: guid, request: `req ${guid}` });
    }

    expect(journal.nextRunnable()?.providerGuid).toBe("IN-A");
    expect(journal.nextRunnable([])?.providerGuid).toBe("IN-A");
    expect(journal.nextRunnable(["key-a"])?.providerGuid).toBe("IN-B");
    // Two placeholders: a mismatch here would bind wrongly or throw.
    expect(journal.nextRunnable(["key-a", "key-b"])?.providerGuid).toBe("IN-C");
    expect(journal.nextRunnable(["key-a", "key-b", "key-c"])).toBeNull();

    // A chat key is a hash, but the clause must still be parameterised, not interpolated.
    journal.admit({ chatId: 4, chatKey: "'); DROP TABLE delivery_events;--", providerGuid: "IN-D", request: "d" });
    expect(journal.nextRunnable(["'); DROP TABLE delivery_events;--"])?.providerGuid).toBe("IN-A");
    expect(
      database.query("SELECT COUNT(*) AS n FROM delivery_events").get() as { n: number },
    ).toEqual({ n: 4 });

    database.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
