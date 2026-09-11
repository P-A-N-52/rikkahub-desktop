// workspace/files.ts — 文件面板的领域操作（M3-5，方案 §4.4）。
// 用户驱动的浏览/预览/重命名/删除/系统资源管理器定位；与 AI 工具路径共用同一套
// 边界断言（assertInsideWorkspace：真实路径与目录身份，软链/盘符兄弟目录逃逸同样被抓）。
// 所有函数以 workspace root 为界；rel 路径来自前端，视作不可信输入。

import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Workspace } from "../foundation/types";
import { isWindowsReservedName, reservedNameSafeFsPath, sweepWindowsReservedNames } from "../foundation/windows-names";
import { reportError } from "../observability/app-errors";
import { assertInsideWorkspace, READ_HARD_LIMIT_BYTES } from "./boundary";
import { resolvePathIdentity, samePathIdentity } from "./path-identity";
import { detectSupportedImageMimeTypeFromFile } from "./tools/mime";

export interface WorkspaceFileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

export type WorkspaceFilePreview =
  | { kind: "text"; text: string; truncated: boolean; size: number }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "binary"; size: number };

const IMAGE_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;

/** rel 路径 → 边界内绝对路径。空串=root 本身。 */
function resolveInside(workspace: Workspace, relPath: string): string {
  return assertInsideWorkspace(join(workspace.root, relPath), workspace.root);
}

export function listWorkspaceDir(workspace: Workspace, relPath: string): WorkspaceFileEntry[] {
  const dir = resolveInside(workspace, relPath);
  const entries: WorkspaceFileEntry[] = [];
  for (const name of readdirSync(dir)) {
    try {
      // 保留名条目(nul 等,问题4)必须经 NT 路径 stat:Win32 语义把它当设备报 ENOENT,
      // 条目被 catch 跳过而在面板"隐身"——残留却在 Explorer 里可见,用户无从处置。
      const stats = statSync(reservedNameSafeFsPath(join(dir, name)));
      entries.push({
        name,
        type: stats.isDirectory() ? "dir" : "file",
        size: stats.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtimeMs,
      });
    } catch {
      // 竞态删除/权限拒绝的条目直接跳过,不炸整个列表
    }
  }
  return entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
}

/** 预览读取:普通路径用 node:fs;NT 前缀路径(保留名残留,问题4)用 Bun.file——Bun 的
 *  node:fs 对裸设备名有特判(读写可能被路由到设备),Bun.file 无此特判(实证 2026-09)。 */
async function readPreviewBuffer(fsPath: string): Promise<Buffer> {
  if (!fsPath.startsWith("\\\\?\\")) return readFileSync(fsPath);
  return Buffer.from(await Bun.file(fsPath).arrayBuffer());
}

/** 首 8KB 含 NUL 即按二进制处理(通用启发,git 同款)。 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export async function previewWorkspaceFile(workspace: Workspace, relPath: string): Promise<WorkspaceFilePreview> {
  const path = resolveInside(workspace, relPath);
  // 保留名文件(问题4)走 NT 路径;stat/mime/读取全部同源,预览残留内容可辅助定位制造者。
  const fsPath = reservedNameSafeFsPath(path);
  const stats = statSync(fsPath);
  if (!stats.isFile()) throw new Error("Not a file");
  const imageMime = await detectSupportedImageMimeTypeFromFile(fsPath);
  if (imageMime) {
    if (stats.size > IMAGE_PREVIEW_LIMIT_BYTES) return { kind: "binary", size: stats.size };
    return { kind: "image", dataUrl: `data:${imageMime};base64,${(await readPreviewBuffer(fsPath)).toString("base64")}`, size: stats.size };
  }
  const truncated = stats.size > READ_HARD_LIMIT_BYTES;
  const buffer = await readPreviewBuffer(fsPath);
  if (looksBinary(buffer)) return { kind: "binary", size: stats.size };
  const slice = truncated ? buffer.subarray(0, READ_HARD_LIMIT_BYTES) : buffer;
  return { kind: "text", text: slice.toString("utf-8"), truncated, size: stats.size };
}

function assertValidEntryName(name: string): void {
  if (!name || name === "." || name === "..") throw new Error("Invalid name");
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error("Name must not contain path separators");
  // 问题4:win32 拒绝设备保留名(nul/con/com1…,含带扩展名形式)——重命名成它即产生残留。
  if (process.platform === "win32" && isWindowsReservedName(name)) {
    throw new Error("Name is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)");
  }
}

export function renameWorkspaceEntry(workspace: Workspace, relPath: string, newName: string): void {
  assertValidEntryName(newName);
  const path = resolveInside(workspace, relPath);
  if (samePathIdentity(resolvePathIdentity(path), resolvePathIdentity(workspace.root))) throw new Error("Cannot rename the workspace root");
  const target = join(dirname(path), newName);
  assertInsideWorkspace(target, workspace.root);
  // 源经 NT 安全路径:保留名残留可被"改名成正常名"救活(问题4 自愈路径);目标名已过校验必非保留名。
  renameSync(reservedNameSafeFsPath(path), target);
}

export function deleteWorkspaceEntry(workspace: Workspace, relPath: string): void {
  const path = resolveInside(workspace, relPath);
  if (samePathIdentity(resolvePathIdentity(path), resolvePathIdentity(workspace.root))) throw new Error("Cannot delete the workspace root");
  // 保留名残留(问题4)必须走 NT 路径删除:Win32 语义下 rmSync 报 ENOENT 被 force 吞掉,
  // 表现为"删除成功但文件还在"的假成功。
  rmSync(reservedNameSafeFsPath(path), { recursive: true, force: true });
}

// ---- AGENTS.md(P4,方案 §3.3:项目级指引 = 工作区根下的真实文件,文件即入口) ----

/** pi 的项目上下文文件候选名(resource-loader.loadContextFileFromDir 逐字同序):
 *  首个命中者即 pi 实际加载的文件。编辑入口读写"pi 眼中的那个文件",都不存在时
 *  新建标准名 AGENTS.md。 */
const PROJECT_CONTEXT_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

const AGENTS_FILE_MAX_BYTES = 512 * 1024;

/** 默认模板(无则引导创建时的初始内容;单一事实源在后端,前端 GET 即得)。 */
export const DEFAULT_AGENTS_TEMPLATE = `# AGENTS.md

Project-specific instructions for the AI agent working in this workspace.

## Overview

(Describe what this project is and what the agent should know about it.)

## Conventions

- (Coding style, naming, directory layout, tools to prefer or avoid...)

## Boundaries

- (Things the agent must not touch or change without asking.)
`;

export interface WorkspaceAgentsFile {
  /** 实际存在的候选文件名;不存在时为将要创建的 "AGENTS.md"。 */
  fileName: string;
  exists: boolean;
  content: string;
  /** 供前端"新建"时预填的默认模板。 */
  template: string;
}

function findProjectContextFile(workspace: Workspace): string | null {
  for (const name of PROJECT_CONTEXT_CANDIDATES) {
    const path = join(workspace.root, name);
    try {
      if (statSync(path).isFile()) return name;
    } catch {
      // 不存在/不可读继续下一个候选
    }
  }
  return null;
}

export function readWorkspaceAgentsFile(workspace: Workspace): WorkspaceAgentsFile {
  const found = findProjectContextFile(workspace);
  if (!found) return { fileName: "AGENTS.md", exists: false, content: "", template: DEFAULT_AGENTS_TEMPLATE };
  const path = resolveInside(workspace, found);
  return {
    fileName: found,
    exists: true,
    content: readFileSync(path, "utf-8"),
    template: DEFAULT_AGENTS_TEMPLATE,
  };
}

export function writeWorkspaceAgentsFile(workspace: Workspace, content: string): WorkspaceAgentsFile {
  if (Buffer.byteLength(content, "utf-8") > AGENTS_FILE_MAX_BYTES) {
    throw new Error("AGENTS.md is too large (limit 512KB)");
  }
  // 写到 pi 实际加载的那个候选(已有 CLAUDE.md 的项目就地编辑,不产生被遮蔽的第二份);
  // 都没有则新建标准名。候选名是白名单常量,边界断言纯属纪律。
  const fileName = findProjectContextFile(workspace) ?? "AGENTS.md";
  const path = assertInsideWorkspace(join(workspace.root, fileName), workspace.root);
  writeFileSync(path, content, "utf-8");
  return { fileName, exists: true, content, template: DEFAULT_AGENTS_TEMPLATE };
}

/** 在系统资源管理器中显示(选中目标)。服务端与用户同机(本地桌面应用),直接 spawn。 */
export function revealWorkspaceEntry(workspace: Workspace, relPath: string): void {
  const path = resolveInside(workspace, relPath);
  if (process.platform === "win32") {
    // explorer /select 的参数不能拆开引号,须整段传
    spawn("explorer.exe", [`/select,${path}`], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", path], { detached: true, stdio: "ignore" }).unref();
  } else {
    // Linux 无通用"选中"协议,退而打开所在目录
    const dir = statSync(path).isDirectory() ? path : dirname(path);
    spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
  }
}
// ---- Windows 保留设备名残留清扫(问题4,2.0.0 内测) ----

/** 清扫工作区目录顶层的保留设备名残留文件并留痕。调用点:bash 工具执行后(runtime.ts 的
 *  operations 包装)与每轮生成开始(pi-engine/runner.ts,存量残留自愈)。
 *  清扫范围与平台守卫见 foundation/windows-names。 */
export function sweepWorkspaceReservedNameArtifacts(dir: string): void {
  const removed = sweepWindowsReservedNames(dir);
  if (removed.length > 0) {
    reportError(
      "workspace",
      "warn",
      `已清理 Windows 保留设备名残留文件:${removed.join("、")}(通常由把 nul 当作丢弃目标的原生程序产生;此类文件在资源管理器中无法删除)`,
      undefined,
      "reserved_name_artifacts_swept",
      { dir, removed: removed.join(",") },
    );
  }
}
