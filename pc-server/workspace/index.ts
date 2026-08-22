// workspace/index.ts — 工作区实体管理(agent 模式地基)
// 纪律:本模块只负责工作区的 CRUD、目录生命周期与边界根解析;
// 工具执行/路径校验/审批在 tools 侧(M1-3/M1-4),不在这里。
// 存储与会话同库(rikka_hub.db,§5.2),表为 PC 自有,跨端导出永不包含(枚举纪律,§9.1)。

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { dataDir, workspacesDir } from "../foundation/paths";
import { systemDenyDirs } from "./boundary";
import type { PcWorkspaceRow, Workspace, WorkspacePermissionPreset, WorkspaceStatus, WorkspaceType } from "../foundation/types";
import { id as newId } from "../foundation/utils";
import { getConversation, getConversationsDb, persistConversation } from "../conversations";
import { scheduleThrottledSaveState, state } from "../persistence/json-store";
import { reportError } from "../observability/app-errors";

const WORKSPACE_NAME_MAX = 80;

// ----- 表结构(幂等,懒建) -----
//
// 不在 conversations/index.ts 里建表:保持模块单向依赖(workspace→conversations),
// 会话库不感知工作区。懒建对活库损坏重建路径同样免疫——重建后的新 Database 实例
// 不在 WeakSet 里,首次访问自动补建。

const ensuredDbs = new WeakSet<Database>();

function db(): Database {
  const handle = getConversationsDb();
  if (!handle) throw new Error("conversations db not open");
  if (!ensuredDbs.has(handle)) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS pc_workspace (
        id                TEXT PRIMARY KEY NOT NULL,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        root              TEXT NOT NULL DEFAULT '',
        permission_preset TEXT NOT NULL,
        trusted_at        INTEGER,
        create_at         INTEGER NOT NULL,
        update_at         INTEGER NOT NULL,
        last_access_at    INTEGER NOT NULL
      );
    `);
    ensuredDbs.add(handle);
  }
  return handle;
}

// ----- 目录布局 -----
//
// 每个工作区(不分类型)在 workspacesDir/<id>/ 下有宿主目录:tmp/ 放超长 shell 输出
// 落盘等 PC 侧杂物(folder 型也在这里,不污染用户目录)。managed 型额外有 files/
// 作为模型可见的边界根。

function hostDir(workspaceId: string): string {
  return join(workspacesDir, workspaceId);
}

export function workspaceTmpDir(workspaceId: string): string {
  return join(hostDir(workspaceId), "tmp");
}

function managedRoot(workspaceId: string): string {
  return join(hostDir(workspaceId), "files");
}

// ----- 行映射 -----
//
// managed 型 root 落库为空串、载入时由当前 dataDir 计算——数据目录整体搬迁
// (RIKKAHUB_PC_DATA_DIR / 便携安装挪盘)后边界根自愈,不留死绝对路径。

function normalizeType(raw: string): WorkspaceType {
  return raw === "folder" ? "folder" : "managed";
}

function normalizePreset(raw: string): WorkspacePermissionPreset {
  if (raw === "confirm_each" || raw === "full_access") return raw;
  return "balanced";
}

function rowToWorkspace(row: PcWorkspaceRow): Workspace {
  const type = normalizeType(row.type);
  return {
    id: row.id,
    name: row.name,
    type,
    root: type === "managed" ? managedRoot(row.id) : row.root,
    permissionPreset: normalizePreset(row.permission_preset),
    trustedAt: row.trusted_at ?? null,
    createAt: row.create_at,
    updateAt: row.update_at,
    lastAccessAt: row.last_access_at,
  };
}

/** 运行时健康状态(计算,不落库):根目录丢失 = missing(对齐安卓 BROKEN,不静默删记录)。 */
export function workspaceStatus(workspace: Workspace): WorkspaceStatus {
  try {
    return statSync(workspace.root).isDirectory() ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

// ----- CRUD -----

export function listWorkspaces(): Workspace[] {
  const rows = db().prepare(
    "SELECT * FROM pc_workspace ORDER BY last_access_at DESC, create_at DESC, id DESC",
  ).all() as PcWorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(workspaceId: string): Workspace | null {
  const row = db().prepare("SELECT * FROM pc_workspace WHERE id = ?").get(workspaceId) as PcWorkspaceRow | null;
  return row ? rowToWorkspace(row) : null;
}

function sanitizeName(raw: unknown, fallback: string): string {
  const name = String(raw ?? "").trim().slice(0, WORKSPACE_NAME_MAX);
  return name || fallback;
}

/** folder 型根目录准入校验。返回规范化绝对路径,不合法抛错(错误文案直达 UI)。 */
export function validateFolderRoot(rawRoot: unknown): string {
  const raw = String(rawRoot ?? "").trim();
  if (!raw || !isAbsolute(raw)) throw new Error("必须提供绝对路径");
  const root = resolve(raw);
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error("目录不存在或不可访问");
  }
  if (!stat.isDirectory()) throw new Error("路径不是目录");
  // 文件系统根(C:\ / /)作为边界等于没有边界
  if (root === resolve(root, "..")) throw new Error("不能以磁盘根目录作为工作区");
  // 与应用数据目录互斥:工作区含 dataDir 或位于 dataDir 内,模型可改写应用自身状态
  const rootPrefixed = root + sep;
  const dataPrefixed = resolve(dataDir) + sep;
  if (rootPrefixed.startsWith(dataPrefixed) || dataPrefixed.startsWith(rootPrefixed)) {
    throw new Error("工作区不能与应用数据目录重叠");
  }
  // 操作系统系统目录拒绝(M1 冒烟发现的缺口):这类目录做工作区无正当场景,
  // 写坏即系统级灾难。只拦"等于或位于系统目录内",不拦包含关系(C:\ 已被盘根规则拦)。
  // Windows 路径大小写不敏感,比较前统一小写。
  const comparable = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  for (const sysDir of systemDenyDirs()) {
    if (comparable(root) === comparable(sysDir) || comparable(rootPrefixed).startsWith(comparable(sysDir + sep))) {
      throw new Error("不能以操作系统目录作为工作区");
    }
  }
  return root;
}

/** 新建 managed 工作区的默认名:首个用"默认工作区",此后取最小空号"工作区 N"——
    避免多个互不相同的工作区顶着同一个名字让人误以为是同一个(G6)。 */
function nextManagedWorkspaceName(): string {
  const names = new Set(
    (db().prepare("SELECT name FROM pc_workspace").all() as { name: string }[]).map((row) => row.name),
  );
  if (!names.has("默认工作区")) return "默认工作区";
  for (let n = 2; ; n += 1) {
    const candidate = `工作区 ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function createWorkspace(input: { type: WorkspaceType; name?: unknown; root?: unknown }): Workspace {
  const now = Date.now();
  const workspaceId = newId();
  let root = "";
  let trustedAt: number | null = now; // managed 型创建即信任(§3.3)
  if (input.type === "folder") {
    root = validateFolderRoot(input.root);
    trustedAt = null; // folder 型必须显式过信任门
  }
  // 默认档位(权限档位改版):一律"默认权限"(balanced);但记住用户上一次的显式选择——
  // 上次切到"完全访问"的用户,新建工作区也从"完全访问"起步。folder 型的风险由信任门把守。
  // state 在启动装载前为 undefined(单测常见),此时按无记忆处理(normalizePreset 回退 balanced)。
  const preset: WorkspacePermissionPreset = normalizePreset(String(state?.settings?.workspaceLastPermissionPreset ?? ""));
  const fallbackName = input.type === "folder" ? root.split(sep).filter(Boolean).pop() ?? "工作区" : nextManagedWorkspaceName();
  const name = sanitizeName(input.name, fallbackName);

  mkdirSync(workspaceTmpDir(workspaceId), { recursive: true });
  if (input.type === "managed") mkdirSync(managedRoot(workspaceId), { recursive: true });

  db().prepare(
    "INSERT INTO pc_workspace (id, name, type, root, permission_preset, trusted_at, create_at, update_at, last_access_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(workspaceId, name, input.type, input.type === "folder" ? root : "", preset, trustedAt, now, now, now);
  const created = getWorkspace(workspaceId);
  if (!created) throw new Error("workspace insert failed");
  return created;
}

export function updateWorkspace(workspaceId: string, patch: { name?: unknown; permissionPreset?: unknown }): Workspace | null {
  const existing = getWorkspace(workspaceId);
  if (!existing) return null;
  const name = patch.name !== undefined ? sanitizeName(patch.name, existing.name) : existing.name;
  let preset = existing.permissionPreset;
  if (patch.permissionPreset !== undefined) {
    const raw = String(patch.permissionPreset);
    if (raw !== "confirm_each" && raw !== "balanced" && raw !== "full_access") {
      throw new Error("无效的权限档位");
    }
    preset = raw;
    if (preset !== existing.permissionPreset && state?.settings) {
      // 记录"用户上一次的选择"作为后续新建工作区的默认档位(PC-only 设置,节流落盘)。
      state.settings.workspaceLastPermissionPreset = preset;
      scheduleThrottledSaveState();
    }
  }
  db().prepare("UPDATE pc_workspace SET name = ?, permission_preset = ?, update_at = ? WHERE id = ?")
    .run(name, preset, Date.now(), workspaceId);
  return getWorkspace(workspaceId);
}

/** 信任门确认(§3.3,folder 型)。managed 型创建即信任,重复调用幂等。 */
export function trustWorkspace(workspaceId: string): Workspace | null {
  const existing = getWorkspace(workspaceId);
  if (!existing) return null;
  if (existing.trustedAt === null) {
    const now = Date.now();
    db().prepare("UPDATE pc_workspace SET trusted_at = ?, update_at = ? WHERE id = ?").run(now, now, workspaceId);
  }
  return getWorkspace(workspaceId);
}

export function touchWorkspaceAccess(workspaceId: string): void {
  db().prepare("UPDATE pc_workspace SET last_access_at = ? WHERE id = ?").run(Date.now(), workspaceId);
}

/**
 * 删除工作区:managed 删托管宿主目录(含 files/),folder 只删 tmp 宿主目录、用户
 * 真实目录一个字节不动(§5.2)。归属会话解绑为对话模式(workspaceId 置空,无数据
 * 丢失;是否连会话一起删由 M2 的 UI 决策,后端保守)。
 *
 * 解绑必须走 working set 权威实例(getConversation→改字段→persistConversation),
 * 不能只 UPDATE 库行——活跃实例内存里还留着旧 workspaceId,后续任何 flush 会把
 * 库行覆盖回去(安卓 moveConversationToFolder 同款教训)。
 *
 * B5-① 原子性:无法包成一个 DB 事务(persistConversation 自带事务,SQLite 不支持
 * 嵌套;且必须走内存实例)。改为"逐个解绑 + 任一失败即时中止"——某个会话解绑失败
 * 立即停手、如实上报已解绑计数、不删工作区记录。残留绑定幂等,用户重试即可续解,
 * 优于"工作区已删但部分会话仍绑着已删 id"的孤儿态。
 */
export function deleteWorkspace(workspaceId: string): boolean {
  const existing = getWorkspace(workspaceId);
  if (!existing) return false;

  const boundIds = (db().prepare("SELECT id FROM pc_conversation WHERE workspace_id = ?").all(workspaceId) as { id: string }[])
    .map((row) => row.id);
  let unbound = 0;
  for (const convId of boundIds) {
    const conversation = getConversation(convId);
    if (!conversation) {
      // 会话行在 SELECT 与解绑之间被并发删除:无需解绑,跳过计入已处理。
      unbound += 1;
      continue;
    }
    conversation.workspaceId = null;
    conversation.workspaceCwd = null;
    conversation.updateAt = Date.now();
    try {
      persistConversation(conversation);
    } catch (err) {
      reportError(
        "workspace",
        "warn",
        `删除工作区失败:解绑会话 ${convId} 时出错(已解绑 ${unbound}/${boundIds.length} 个,工作区未删除,可重试)`,
        err,
        "workspace_delete_unbind_failed",
        { workspaceId, failedConversationId: convId, unbound, total: boundIds.length },
      );
      return false;
    }
    unbound += 1;
  }

  db().prepare("DELETE FROM pc_workspace WHERE id = ?").run(workspaceId);

  // 目录清理尽力而为:失败(文件占用/权限)只上报不回滚——记录已删,残留目录无引用,
  // 下次同 id 不会再出现(id 是 UUID)
  const dir = hostDir(workspaceId);
  // 防御性断言:被删目录必须在托管宿主目录之下,绝不触碰 folder 型的用户真实目录
  if (resolve(dir).startsWith(resolve(workspacesDir) + sep) && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      reportError("workspace", "warn", `工作区目录清理失败(记录已删除,残留目录可手动清理):${dir}`, err, "workspace_dir_cleanup_failed");
    }
  }
  return true;
}
