// workspace/workspace.test.ts — 工作区实体管理单测(M1-1)
// 覆盖:managed/folder 创建与目录生命周期、folder 根目录准入校验、权限档位、
// 信任门、删除(目录清理 + 归属会话经 working set 权威实例解绑)、列迁移幂等。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-workspace-test-"));

const { workspacesDir, dataDir } = await import("../foundation/paths");
const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("./index");

const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: () => false,
  hasSseClients: () => false,
  hasDirty: () => false,
});

function makeConversation(convId: string, workspaceId: string | null) {
  return {
    id: convId,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${convId}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId,
    workspaceCwd: workspaceId ? "sub" : null,
  };
}

describe("managed 工作区", () => {
  test("创建:托管目录落地、创建即信任、默认平衡档、root 指向 files/", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "  我的工作区  " });
    expect(workspace.name).toBe("我的工作区");
    expect(workspace.type).toBe("managed");
    expect(workspace.permissionPreset).toBe("balanced");
    expect(workspace.trustedAt).not.toBeNull();
    expect(workspace.root).toBe(join(workspacesDir, workspace.id, "files"));
    expect(existsSync(workspace.root)).toBe(true);
    expect(existsSync(ws.workspaceTmpDir(workspace.id))).toBe(true);
    expect(ws.workspaceStatus(workspace)).toBe("ready");
  });

  test("空名回退默认名;列表可见", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "   " });
    expect(workspace.name).toBe("默认工作区");
    expect(ws.listWorkspaces().some((w) => w.id === workspace.id)).toBe(true);
  });
});

describe("folder 工作区准入校验", () => {
  test("拒绝:相对路径/不存在/文件/盘符根/与数据目录重叠", () => {
    expect(() => ws.createWorkspace({ type: "folder", root: "relative/path" })).toThrow("绝对路径");
    expect(() => ws.createWorkspace({ type: "folder", root: join(tmpdir(), "rkh-definitely-missing-xyz") })).toThrow("不存在");
    const filePath = join(mkdtempSync(join(tmpdir(), "rkh-ws-f-")), "a.txt");
    writeFileSync(filePath, "x");
    expect(() => ws.createWorkspace({ type: "folder", root: filePath })).toThrow("不是目录");
    const diskRoot = parse(tmpdir()).root;
    expect(() => ws.createWorkspace({ type: "folder", root: diskRoot })).toThrow("根目录");
    expect(() => ws.createWorkspace({ type: "folder", root: dataDir })).toThrow("重叠");
    expect(() => ws.createWorkspace({ type: "folder", root: join(dataDir, "workspaces") })).toThrow("重叠");
    const parentOfData = join(dataDir, "..");
    expect(() => ws.createWorkspace({ type: "folder", root: parentOfData })).toThrow("重叠");
  });

  test("合法目录:未信任、每步确认档、默认名取目录名;信任门幂等", () => {
    const realDir = mkdtempSync(join(tmpdir(), "rkh-ws-real-"));
    const workspace = ws.createWorkspace({ type: "folder", root: realDir });
    expect(workspace.type).toBe("folder");
    expect(workspace.trustedAt).toBeNull();
    expect(workspace.permissionPreset).toBe("confirm_each");
    expect(workspace.name).toBe(realDir.split(sep).filter(Boolean).pop() ?? "");
    expect(workspace.root).toBe(realDir);

    const trusted = ws.trustWorkspace(workspace.id);
    expect(trusted?.trustedAt).not.toBeNull();
    const again = ws.trustWorkspace(workspace.id);
    expect(again?.trustedAt).toBe(trusted?.trustedAt);
  });

  test("根目录丢失 → status=missing(记录保留,对齐安卓 BROKEN)", () => {
    const goneDir = mkdtempSync(join(tmpdir(), "rkh-ws-gone-"));
    const workspace = ws.createWorkspace({ type: "folder", root: goneDir });
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(goneDir, { recursive: true, force: true });
    expect(ws.workspaceStatus(ws.getWorkspace(workspace.id)!)).toBe("missing");
    expect(ws.getWorkspace(workspace.id)).not.toBeNull();
  });
});

describe("更新与删除", () => {
  test("更新:改名+档位;无效档位拒绝", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "改名前" });
    const updated = ws.updateWorkspace(workspace.id, { name: "改名后", permissionPreset: "full_access" });
    expect(updated?.name).toBe("改名后");
    expect(updated?.permissionPreset).toBe("full_access");
    expect(() => ws.updateWorkspace(workspace.id, { permissionPreset: "yolo" })).toThrow("档位");
  });

  test("删除 managed:宿主目录清除、归属会话解绑为对话模式(库行+权威实例)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "待删" });
    const conv = makeConversation("conv-detach-1", workspace.id);
    conversations.persistConversation(conv);
    // 命中 working set:模拟活跃实例(检验解绑写的是权威实例而非仅库行)
    const held = conversations.getConversation(conv.id);
    expect(held?.workspaceId).toBe(workspace.id);

    expect(ws.deleteWorkspace(workspace.id)).toBe(true);
    expect(ws.getWorkspace(workspace.id)).toBeNull();
    expect(existsSync(join(workspacesDir, workspace.id))).toBe(false);
    // 权威实例已解绑
    expect(conversations.getConversation(conv.id)?.workspaceId).toBeNull();
    // 库行已解绑
    const row = db.prepare("SELECT workspace_id, workspace_cwd FROM pc_conversation WHERE id = ?").get(conv.id) as { workspace_id: string | null; workspace_cwd: string | null };
    expect(row.workspace_id).toBeNull();
    expect(row.workspace_cwd).toBeNull();
  });

  test("删除 folder:用户目录不动,仅宿主目录与记录消失", () => {
    const realDir = mkdtempSync(join(tmpdir(), "rkh-ws-keep-"));
    writeFileSync(join(realDir, "keep.txt"), "data");
    const workspace = ws.createWorkspace({ type: "folder", root: realDir });
    expect(ws.deleteWorkspace(workspace.id)).toBe(true);
    expect(existsSync(join(realDir, "keep.txt"))).toBe(true);
    expect(existsSync(join(workspacesDir, workspace.id))).toBe(false);
  });

  test("删除不存在的工作区返回 false", () => {
    expect(ws.deleteWorkspace("no-such-id")).toBe(false);
  });
});

describe("会话工作区列迁移", () => {
  test("workspace_id/workspace_cwd 随会话行写读回;老行缺省为 null", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "列迁移" });
    const bound = makeConversation("conv-cols-1", workspace.id);
    conversations.persistConversation(bound);
    const metas = conversations.loadConversationMetasFromDb(db);
    const boundMeta = metas.find((m) => m.id === bound.id);
    expect(boundMeta?.workspaceId).toBe(workspace.id);
    expect(boundMeta?.workspaceCwd).toBe("sub");

    const plain = makeConversation("conv-cols-2", null);
    conversations.persistConversation(plain);
    const plainMeta = conversations.loadConversationMetasFromDb(db).find((m) => m.id === plain.id);
    expect(plainMeta?.workspaceId).toBeNull();
    expect(plainMeta?.workspaceCwd).toBeNull();
  });

  test("建表/迁移幂等:对同一库重复执行不报错不丢数据", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM pc_workspace").get() as { n: number };
    conversations.ensureConversationTables(db);
    // 重新触发工作区模块的懒建路径(同一 Database 实例走 WeakSet 直通,再显式建一次表验证幂等)
    db.exec("CREATE TABLE IF NOT EXISTS pc_workspace (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, root TEXT NOT NULL DEFAULT '', permission_preset TEXT NOT NULL, trusted_at INTEGER, create_at INTEGER NOT NULL, update_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL)");
    const after = db.prepare("SELECT COUNT(*) AS n FROM pc_workspace").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(ws.listWorkspaces().length).toBeGreaterThan(0);
  });
});
