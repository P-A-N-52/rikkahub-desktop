// 批次一 R4-1/R4-2 端到端回归:恢复备份必须重建迁移标记;恢复失败必须整体回滚。
// 原缺陷:①pc-backup.json 不导出 appliedMigrations,恢复后 CONVERSATIONS_SQLITE 等标记
// 丢失,下次启动方案 B 把 pre-sqlite.bak 化石会话灌回活库(删掉的会话复活/同 id 被旧树
// 覆盖);②恢复中途失败(如会话灌库异常)留下半应用状态:备份的 settings 已生效、
// 暂存 conversations 挂在 state 上被后续 saveState 持久化。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const serverEntry = join(import.meta.dir, "..", "server.ts");

async function importJsonBackup(base: string, backup: unknown): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
  return fetch(`${base}/api/data/import`, { method: "POST", body: form });
}

/** saveState 是 fire-and-forget,落盘有毫秒级延迟——轮询直到断言成立或超时。 */
async function poll<T>(fn: () => T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = fn();
      if (v !== null) return v;
    } catch { /* 文件尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("poll 超时");
}

describe("恢复备份重建迁移标记(R4-1)+ 恢复失败整体回滚(R4-2)", () => {
  test("恢复 settings-only 备份后,state.json 的 appliedMigrations 含全部恢复保障标记", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-markers-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18251", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const base = `http://127.0.0.1:${port}`;

      const res = await importJsonBackup(base, { state: { settings: { assistantId: "markers-check" } } });
      expect(res.status).toBe(200);

      // 原缺陷断言点:恢复重建 state 后标记全丢,只有 memory-file-split 被单独补回。
      const markers = await poll(() => {
        const parsed = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as { settings?: { assistantId?: string }; appliedMigrations?: string[] };
        if (parsed.settings?.assistantId !== "markers-check") return null; // 导入结果尚未落盘
        return Array.isArray(parsed.appliedMigrations) ? parsed.appliedMigrations : null;
      });
      expect(markers).toContain("conversations-sqlite-1.2.6");
      expect(markers).toContain("memory-file-split-1.3.2");
      expect(markers).toContain("file-dedup-2.0");
      expect(markers).toContain("provider-reorder-1.1.1");
    } finally {
      proc.kill();
    }
  }, 40_000);

  test("恢复中途失败(会话灌库异常)→ 整体回滚,设置与会话回到导入前", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-rollback-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18252", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const base = `http://127.0.0.1:${port}`;

      // 1) 先恢复一份好备份,建立"导入前"基线
      const okRes = await importJsonBackup(base, {
        state: {
          settings: { assistantId: "before-rollback" },
          conversations: [{ id: "conv-keep", assistantId: "a", title: "保留我", messages: [], createAt: 1, updateAt: 1 }],
        },
      });
      expect(okRes.status).toBe(200);

      // 2) 再恢复毒备份:settings 变化 + 会话 id 是对象 → finalize 灌库时 SQLite 绑定报错
      const poisonRes = await importJsonBackup(base, {
        state: {
          settings: { assistantId: "poison" },
          conversations: [{ id: { evil: true }, title: "毒会话", messages: [] }],
        },
      });
      expect(poisonRes.status).toBeGreaterThanOrEqual(400);

      // 3) 原缺陷断言点:失败后设置必须还是导入前的(旧实现留下半应用的 poison 设置)
      const settings = (await (await fetch(`${base}/api/settings`)).json()) as { assistantId?: string };
      expect(settings.assistantId).toBe("before-rollback");

      // 4) 回滚结果落盘:state.json 里不允许残留 poison 设置或暂存 conversations
      await poll(() => {
        const parsed = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as { settings?: { assistantId?: string }; conversations?: unknown };
        if (parsed.settings?.assistantId !== "before-rollback") return null;
        if (parsed.conversations !== undefined) return null; // 暂存字段必须已清
        return true;
      });

      // 5) 会话活库未被毒备份触碰:停服后直接查库(reset 单事务,失败即整体回滚)
      proc.kill();
      await proc.exited;
      const db = new Database(join(dataDir, "rikka_hub.db"), { readonly: true });
      try {
        const keep = db.query("SELECT COUNT(*) AS n FROM pc_conversation WHERE id = 'conv-keep'").get() as { n: number };
        expect(keep.n).toBe(1);
        const poisoned = db.query("SELECT COUNT(*) AS n FROM pc_conversation WHERE title = '毒会话'").get() as { n: number };
        expect(poisoned.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      proc.kill();
    }
  }, 40_000);
});
