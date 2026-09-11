import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setup = `
  import { Database } from "bun:sqlite";
  import { beginConversationShutdown, openConversationsDb, initConversationsRuntime, persistConversation, flushConvDirtyNow, markConversationRowDirty, markMessageNodeDirty, checkpointConversationsDb, deletePcConversations, resetConversationsDbTo } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
  import { registerConversation, removeConversations, sweepWorkingSet, peekConversation } from ${JSON.stringify(join(import.meta.dir, "working-set.ts"))};
  import { conversationsDbPath } from ${JSON.stringify(join(import.meta.dir, "../foundation/paths.ts"))};
  const db = openConversationsDb();
  initConversationsRuntime();
  const create = id => {
    const conv = { id, assistantId: "fixture", title: "before", systemPrompt: null, messages: [{ id: id + "-node", selectIndex: 0, messages: [] }], chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1 };
    registerConversation(conv); persistConversation(conv); return conv;
  };
  const title = id => db.query("SELECT title FROM pc_conversation WHERE id = ?").get(id)?.title;
  const strict = () => ({ requireSuccess: true, deadline: Date.now() + 1000 });
`;

async function fixture(source: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "rikka-shutdown-sqlite-"));
  try {
    const path = join(dir, "fixture.ts");
    writeFileSync(path, setup + source);
    const child = Bun.spawn([process.execPath, path], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: join(dir, "data"), RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`SQLite fixture failed (${code}): ${stderr}\n${stdout}`);
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("shutdown SQLite persistence", () => {
  test("dirty writes survive ordinary failure; one shared deadline bounds multiple locked rows", async () => {
    const result = await fixture(`
      const conversations = ["one", "two", "three"].map(create);
      for (const conv of conversations) { conv.title = "saved-after-retry"; markConversationRowDirty(conv.id); markMessageNodeDirty(conv.id, conv.messages[0].id); }
      const blocker = new Database(conversationsDbPath);
      blocker.exec("BEGIN IMMEDIATE");
      db.exec("PRAGMA busy_timeout = 10");
      flushConvDirtyNow();
      db.exec("PRAGMA busy_timeout = 5000");
      let failure = "";
      const start = Date.now();
      try { flushConvDirtyNow({ requireSuccess: true, deadline: start + 120 }); } catch (error) { failure = error.message; }
      const elapsed = Date.now() - start;
      const restoredTimeout = db.query("PRAGMA busy_timeout").get().timeout;
      blocker.exec("ROLLBACK"); blocker.close();
      flushConvDirtyNow(strict());
      checkpointConversationsDb(strict());
      console.log(JSON.stringify({ failed: !!failure, elapsed, restoredTimeout, titles: conversations.map(conv => title(conv.id)), integrity: db.query("PRAGMA integrity_check").get().integrity_check }));
      db.close();
    `);
    expect(result.failed).toBe(true);
    expect(result.elapsed).toBeLessThan(500);
    expect(result.restoredTimeout).toBe(5000);
    expect(result.titles).toEqual(["saved-after-retry", "saved-after-retry", "saved-after-retry"]);
    expect(result.integrity).toBe("ok");
  });

  test("shutdown finally writes inherit one deadline and cannot extend it explicitly", async () => {
    const result = await fixture(`
      const conv = create("finally");
      conv.title = "waiting-for-lock";
      const blocker = new Database(conversationsDbPath);
      blocker.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      beginConversationShutdown(started + 100);
      let defaultFailed = false;
      try { persistConversation(conv); } catch { defaultFailed = true; }
      beginConversationShutdown(started + 5000);
      let explicitFailed = false;
      try { persistConversation(conv, { deadline: started + 5000 }); } catch { explicitFailed = true; }
      const elapsed = Date.now() - started;
      blocker.exec("ROLLBACK"); blocker.close();
      console.log(JSON.stringify({ defaultFailed, explicitFailed, elapsed, savedTitle: title(conv.id), restoredTimeout: db.query("PRAGMA busy_timeout").get().timeout }));
      db.close();
    `);
    expect(result.defaultFailed).toBe(true);
    expect(result.explicitFailed).toBe(true);
    expect(result.elapsed).toBeLessThan(450);
    expect(result.savedTitle).toBe("before");
    expect(result.restoredTimeout).toBe(5000);
  });

  test("failed full reconcile stays resident after generation ends and is retried atomically", async () => {
    const result = await fixture(`
      const conv = create("reconcile");
      conv.title = "latest";
      conv.messages = [{ id: "replacement-node", selectIndex: 0, messages: [] }];
      db.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON pc_message_node BEGIN SELECT RAISE(ABORT, 'synthetic reconcile failure'); END");
      let initialFailure = false;
      try { persistConversation(conv); } catch { initialFailure = true; }
      sweepWorkingSet(Date.now() + 120000);
      const retained = peekConversation(conv.id) === conv;
      const oldTitle = title(conv.id);
      let strictFailure = false;
      try { flushConvDirtyNow(strict()); } catch { strictFailure = true; }
      db.exec("DROP TRIGGER fail_reconcile");
      flushConvDirtyNow(strict());
      checkpointConversationsDb(strict());
      console.log(JSON.stringify({ initialFailure, strictFailure, retained, oldTitle, newTitle: title(conv.id), nodes: db.query("SELECT id FROM pc_message_node WHERE conversation_id = ?").all(conv.id).map(row => row.id) }));
      db.close();
    `);
    expect(result).toEqual({ initialFailure: true, strictFailure: true, retained: true, oldTitle: "before", newTitle: "latest", nodes: ["replacement-node"] });
  });

  test("deletion and full import invalidate pending reconciles instead of reviving old conversations", async () => {
    const result = await fixture(`
      const removed = create("removed");
      const replaced = create("replaced");
      db.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON pc_message_node BEGIN SELECT RAISE(ABORT, 'synthetic reconcile failure'); END");
      for (const conv of [removed, replaced]) { conv.title = "unsaved"; try { persistConversation(conv); } catch {} }
      db.exec("DROP TRIGGER fail_reconcile");
      removeConversations([removed.id]); deletePcConversations([removed.id]);
      flushConvDirtyNow(strict());
      const deleted = title(removed.id) === undefined;
      db.exec("CREATE TRIGGER fail_again BEFORE INSERT ON pc_message_node BEGIN SELECT RAISE(ABORT, 'synthetic reconcile failure'); END");
      replaced.title = "old-unsaved"; try { persistConversation(replaced); } catch {}
      db.exec("DROP TRIGGER fail_again");
      resetConversationsDbTo([]);
      flushConvDirtyNow(strict());
      console.log(JSON.stringify({ deleted, afterImport: db.query("SELECT COUNT(*) AS count FROM pc_conversation").get().count }));
      db.close();
    `);
    expect(result).toEqual({ deleted: true, afterImport: 0 });
  });

  test("checkpoint reports a live reader instead of claiming WAL truncation succeeded", async () => {
    const result = await fixture(`
      const conv = create("checkpoint");
      const reader = new Database(conversationsDbPath);
      reader.exec("BEGIN"); reader.query("SELECT * FROM pc_conversation").all();
      conv.title = "after-reader-snapshot"; persistConversation(conv);
      db.exec("PRAGMA busy_timeout = 0");
      checkpointConversationsDb();
      db.exec("PRAGMA busy_timeout = 5000");
      const start = Date.now(); let error = "";
      try { checkpointConversationsDb({ requireSuccess: true, deadline: start + 100 }); } catch (failure) { error = failure.message; }
      const elapsed = Date.now() - start;
      reader.exec("ROLLBACK"); reader.close();
      checkpointConversationsDb(strict());
      const checked = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      console.log(JSON.stringify({ failed: !!error, elapsed, checked, restoredTimeout: db.query("PRAGMA busy_timeout").get().timeout }));
      db.close();
    `);
    expect(result.failed).toBe(true);
    expect(result.elapsed).toBeLessThan(450);
    expect(result.checked).toEqual({ busy: 0, log: 0, checkpointed: 0 });
    expect(result.restoredTimeout).toBe(5000);
  });
});
