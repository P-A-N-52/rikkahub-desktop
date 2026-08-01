// read-queries 单测（DB-first 批1）：排序不变式、助手过滤、字段还原、容错。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables } from "./index";
import {
  conversationExistsInDb,
  countConversations,
  getConversationMeta,
  listAllConversationMetas,
  listConversationMetas,
  pagedConversationMetas,
  recentConversationMetas,
} from "./read-queries";

function seededDb(): Database {
  // 真实 schema(ensureConversationTables)而非私有副本:列演进(如工作区列)时私有
  // schema 会与 META_COLUMNS 漂移导致整批查询报错(2-0 教训的变体)。
  const db = new Database(":memory:");
  ensureConversationTables(db);
  const ins = db.prepare(
    "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // a1 三个会话：c3 最新建、c1 最旧建但最近更新；b-only 属于另一助手
  ins.run("c1", "a1", "第一", "sys", '["s"]', 1, 1000, 9000);
  ins.run("c2", "a1", "第二", "", "[]", 0, 2000, 2100);
  ins.run("c3", "a1", "第三", "", "{bad json", 0, 3000, 3100);
  ins.run("b1", "a2", "别家", "", "[]", 0, 5000, 5100);
  return db;
}

describe("listConversationMetas", () => {
  test("按 create_at 倒序（旧数组顺序等价），只含该助手，messages 恒空", () => {
    const metas = listConversationMetas(seededDb(), "a1");
    expect(metas.map((m) => m.id)).toEqual(["c3", "c2", "c1"]);
    expect(metas.every((m) => m.messages.length === 0)).toBe(true);
  });

  test("字段还原与损坏 suggestions 容错", () => {
    const metas = listConversationMetas(seededDb(), "a1");
    const c1 = metas.find((m) => m.id === "c1")!;
    expect(c1.isPinned).toBe(true);
    expect(c1.systemPrompt).toBe("sys");
    expect(c1.chatSuggestions).toEqual(["s"]);
    const c3 = metas.find((m) => m.id === "c3")!;
    expect(c3.chatSuggestions).toEqual([]);
  });
});

describe("recentConversationMetas", () => {
  test("update_at 倒序 + 排除指定 id + limit", () => {
    const metas = recentConversationMetas(seededDb(), "a1", "c3", 10);
    expect(metas.map((m) => m.id)).toEqual(["c1", "c2"]);
    expect(recentConversationMetas(seededDb(), "a1", undefined, 1).map((m) => m.id)).toEqual(["c1"]);
  });
});

describe("辅助查询", () => {
  test("count 不分助手、exists、单条 meta", () => {
    const db = seededDb();
    expect(countConversations(db)).toBe(4);
    expect(listAllConversationMetas(db)).toHaveLength(4);
    expect(conversationExistsInDb(db, "b1")).toBe(true);
    expect(conversationExistsInDb(db, "nope")).toBe(false);
    expect(getConversationMeta(db, "c2")?.title).toBe("第二");
    expect(getConversationMeta(db, "nope")).toBeNull();
  });
});

describe("pagedConversationMetas(专题2 J 族)", () => {
  test("排序:置顶优先 → updateAt 倒序;并列回退 createAt/id 倒序", () => {
    const db = seededDb();
    // c1 置顶(updateAt 9000);c2/c3 未置顶,updateAt 2100/3100
    const { items, total } = pagedConversationMetas(db, "a1", 0, 10);
    expect(items.map((m) => m.id)).toEqual(["c1", "c3", "c2"]);
    expect(total).toBe(3);
  });

  test("分页边界:offset/limit/total/跨页拼接完整且不重叠", () => {
    const db = seededDb();
    const p1 = pagedConversationMetas(db, "a1", 0, 2);
    const p2 = pagedConversationMetas(db, "a1", 2, 2);
    expect(p1.items.map((m) => m.id)).toEqual(["c1", "c3"]);
    expect(p2.items.map((m) => m.id)).toEqual(["c2"]);
    expect(p1.total).toBe(3);
    expect(pagedConversationMetas(db, "a1", 99, 10).items).toEqual([]);
    expect(pagedConversationMetas(db, "a2", 0, 10).items.map((m) => m.id)).toEqual(["b1"]);
  });

  test("与旧 JS 管线逐元素等价(随机数据,含 updateAt/isPinned 并列)", () => {
    const db = new Database(":memory:");
    ensureConversationTables(db);
    const ins = db.prepare(
      "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // 刻意制造大量并列:updateAt 只取 3 个值,createAt 只取 5 个值,置顶约 1/3
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 200; i++) {
      ins.run(`c${String(i).padStart(3, "0")}`, "a1", `t${i}`, "", "[]", rand(3) === 0 ? 1 : 0, 1000 + rand(5), 5000 + rand(3));
    }
    // 旧 JS 管线:createAt DESC, id DESC 基序(listConversationMetas)+ 稳定排序
    const reference = listConversationMetas(db, "a1")
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updateAt - a.updateAt)
      .map((m) => m.id);
    const sql = pagedConversationMetas(db, "a1", 0, 200).items.map((m) => m.id);
    expect(sql).toEqual(reference);
    // 任意页切片与全量切片一致
    for (const [off, lim] of [[0, 7], [7, 7], [50, 30], [195, 10]] as const) {
      expect(pagedConversationMetas(db, "a1", off, lim).items.map((m) => m.id)).toEqual(reference.slice(off, off + lim));
    }
  });
});
