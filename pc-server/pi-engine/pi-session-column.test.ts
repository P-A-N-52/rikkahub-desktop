// pi-engine/pi-session-column.test.ts — pi_session_file 列与删除级联回归(P2/P5)
//
// 覆盖:新库 schema 往返、老库 ALTER 升级、PC 自家 dump 携带、fork 语义(P5 裁决:引擎
// 记忆随 fork 复制为独立副本,绝不共写同一 jsonl)、删除会话级联清 jsonl(真实 helpers 链路)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { Conversation, State } from "../foundation/types";
import {
  ensureConversationPiSessionColumn,
  ensureConversationTables,
  loadConversationMetasFromDb,
  migrateConversationsIntoDb,
  openConversationsDb,
  persistConversation,
  upsertConversationRowInto,
} from "../conversations/index";
import { ensureMessageFtsTable } from "../conversations/fts";
import { deleteConversationsById } from "../conversations/helpers";
import { generating } from "../conversations/generation-state";
import { configureWorkingSet, registerConversation } from "../conversations/working-set";
import { setState, state } from "../persistence/json-store";
import { copyPiSessionFileForFork, deletePiSessionFiles, piSessionsDir, resolvePiSessionPath } from "./session-files";

// bun test 单进程跑全部文件:全局 state 用后必须恢复,不向后续测试文件泄漏
// (workspace 系测试对 state 形状有自己的假设,泄漏最小 state 会让它们假失败)。
const priorState = state;

beforeAll(() => {
  configureWorkingSet({
    loadConversation: () => undefined,
    isGenerating: (id) => generating.has(id),
    hasSseClients: () => false,
    hasDirty: () => false,
  });
  // broadcastList 读 state.settings.assistantId(沙箱进程无 bootstrap,注入最小 state)
  setState({ settings: { assistantId: "a-1" } } as unknown as State);
});

afterAll(() => {
  setState(priorState);
});

function conv(id: string, piSessionFile: string | null): Conversation {
  return {
    id,
    assistantId: "a-1",
    systemPrompt: null,
    title: "t",
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
    piSessionFile,
  };
}

describe("pi_session_file 列", () => {
  test("新库 schema:upsert → load 往返", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    ensureConversationTables(db);
    ensureMessageFtsTable(db);
    upsertConversationRowInto(db, conv("c1", "c1.jsonl"));
    upsertConversationRowInto(db, conv("c2", null));
    const metas = loadConversationMetasFromDb(db);
    expect(metas.find((m) => m.id === "c1")?.piSessionFile).toBe("c1.jsonl");
    expect(metas.find((m) => m.id === "c2")?.piSessionFile).toBeNull();
  });

  test("老库升级:无列的旧 schema 经 ALTER 迁移后可读写,旧行为 NULL", () => {
    const db = new Database(":memory:");
    // 手工重建 P2 之前的旧表(无 pi_session_file)
    db.exec(`
      CREATE TABLE pc_conversation (
        id TEXT PRIMARY KEY NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '', suggestions TEXT NOT NULL DEFAULT '[]',
        is_pinned INTEGER NOT NULL DEFAULT 0, create_at INTEGER NOT NULL, update_at INTEGER NOT NULL,
        mode_injection_ids TEXT NOT NULL DEFAULT '[]', lorebook_ids TEXT NOT NULL DEFAULT '[]',
        workspace_id TEXT, workspace_cwd TEXT
      );
    `);
    db.prepare(
      "INSERT INTO pc_conversation (id, assistant_id, create_at, update_at) VALUES ('old1', 'a', 1, 1)",
    ).run();
    ensureConversationPiSessionColumn(db);
    ensureConversationPiSessionColumn(db); // 幂等
    const metas = loadConversationMetasFromDb(db);
    expect(metas[0]?.piSessionFile).toBeNull();
    upsertConversationRowInto(db, conv("old1", "old1.jsonl"));
    expect(loadConversationMetasFromDb(db)[0]?.piSessionFile).toBe("old1.jsonl");
  });

  test("migrateConversationsIntoDb 携带列(PC dump 导入/重灌路径)", () => {
    const db = new Database(":memory:");
    ensureConversationTables(db);
    ensureMessageFtsTable(db);
    migrateConversationsIntoDb(db, [conv("m1", "m1.jsonl")]);
    expect(loadConversationMetasFromDb(db)[0]?.piSessionFile).toBe("m1.jsonl");
  });

  test("删除会话级联清 jsonl(真实 helpers 链路:活库列收集 → 删行 → 删文件)", () => {
    // 沙箱数据目录(test-preload)里真开活库,走生产同款 db 权威分支。
    openConversationsDb();
    mkdirSync(piSessionsDir, { recursive: true });
    const fileName = "conv-del-1.jsonl";
    writeFileSync(resolvePiSessionPath(fileName), '{"type":"session"}\n');
    const conversation = conv("conv-del-1", fileName);
    registerConversation(conversation);
    persistConversation(conversation);
    expect(existsSync(resolvePiSessionPath(fileName))).toBe(true);
    deleteConversationsById(new Set(["conv-del-1"]));
    expect(existsSync(resolvePiSessionPath(fileName))).toBe(false);
  });

  test("copyPiSessionFileForFork:复制为目标确定性命名的独立副本;源缺失/空值返回 null(P5)", () => {
    mkdirSync(piSessionsDir, { recursive: true });
    const sourceName = "conv-fork-src.jsonl";
    writeFileSync(resolvePiSessionPath(sourceName), '{"type":"session"}\n');
    expect(copyPiSessionFileForFork(sourceName, "fork-1")).toBe("fork-1.jsonl");
    // 独立副本:源后续变化不影响副本(双会话共写同一 jsonl 的污染面被切断)
    writeFileSync(resolvePiSessionPath(sourceName), "changed\n");
    expect(readFileSync(resolvePiSessionPath("fork-1.jsonl"), "utf-8")).toBe('{"type":"session"}\n');
    expect(copyPiSessionFileForFork(null, "fork-2")).toBeNull();
    expect(copyPiSessionFileForFork("missing.jsonl", "fork-3")).toBeNull();
  });

  test("deletePiSessionFiles:空值跳过、不存在不报错、路径分隔符被剥掉", () => {
    mkdirSync(piSessionsDir, { recursive: true });
    const fileName = "conv-del-2.jsonl";
    writeFileSync(resolvePiSessionPath(fileName), "x\n");
    deletePiSessionFiles([null, undefined, "missing.jsonl", `../../${fileName}`]);
    expect(existsSync(resolvePiSessionPath(fileName))).toBe(false);
  });
});
