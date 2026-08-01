// workspace/files.ts — 文件面板的领域操作（M3-5，方案 §4.4）。
// 用户驱动的浏览/预览/重命名/删除/系统资源管理器定位；与 AI 工具路径共用同一套
// 边界断言（assertInsideWorkspace：realpath+带分隔符前缀，软链/盘符兄弟目录逃逸同样被抓）。
// 所有函数以 workspace root 为界；rel 路径来自前端，视作不可信输入。

import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Workspace } from "../foundation/types";
import { assertInsideWorkspace, READ_HARD_LIMIT_BYTES } from "./boundary";
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
      const stats = statSync(join(dir, name));
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

/** 首 8KB 含 NUL 即按二进制处理(通用启发,git 同款)。 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export async function previewWorkspaceFile(workspace: Workspace, relPath: string): Promise<WorkspaceFilePreview> {
  const path = resolveInside(workspace, relPath);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("Not a file");
  const imageMime = await detectSupportedImageMimeTypeFromFile(path);
  if (imageMime) {
    if (stats.size > IMAGE_PREVIEW_LIMIT_BYTES) return { kind: "binary", size: stats.size };
    return { kind: "image", dataUrl: `data:${imageMime};base64,${readFileSync(path).toString("base64")}`, size: stats.size };
  }
  const truncated = stats.size > READ_HARD_LIMIT_BYTES;
  const buffer = readFileSync(path);
  if (looksBinary(buffer)) return { kind: "binary", size: stats.size };
  const slice = truncated ? buffer.subarray(0, READ_HARD_LIMIT_BYTES) : buffer;
  return { kind: "text", text: slice.toString("utf-8"), truncated, size: stats.size };
}

function assertValidEntryName(name: string): void {
  if (!name || name === "." || name === "..") throw new Error("Invalid name");
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error("Name must not contain path separators");
}

export function renameWorkspaceEntry(workspace: Workspace, relPath: string, newName: string): void {
  assertValidEntryName(newName);
  const path = resolveInside(workspace, relPath);
  if (comparable(path) === comparable(workspace.root)) throw new Error("Cannot rename the workspace root");
  const target = join(dirname(path), newName);
  assertInsideWorkspace(target, workspace.root);
  renameSync(path, target);
}

export function deleteWorkspaceEntry(workspace: Workspace, relPath: string): void {
  const path = resolveInside(workspace, relPath);
  if (comparable(path) === comparable(workspace.root)) throw new Error("Cannot delete the workspace root");
  rmSync(path, { recursive: true, force: true });
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
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