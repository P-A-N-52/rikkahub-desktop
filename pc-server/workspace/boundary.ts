// workspace/boundary.ts — 工作区路径边界与限额(M1-3,PC 自建安全壳)
//
// pi 的 resolveToCwd 没有任何边界校验(pi 信任 cwd,安全外包给终端用户)。消费级桌面
// 应用不能如此:所有文件工具的 Operations 注入点在此包裹——工具内核(pi 原样)算出
// 绝对路径后,每次文件系统操作前先过 assertInsideWorkspace。
//
// 校验语义(§5.3):
// - resolve + realpath 后必须以 workspace root(同样 realpath 化)为前缀,前缀必须带
//   分隔符(skills-import.ts 的盘符兄弟目录教训:C:\ws 不能放行 C:\ws2\x);
// - 目标不存在时(write 新文件/新目录)取"最深存在祖先"的 realpath 再拼回剩余段——
//   祖先链里的软链逃逸照样被抓;
// - Windows 大小写不敏感比较(realpath 已归一盘符大小写,双保险);
// - 软链本体在区内、指向区外 → realpath 后前缀不匹配 → 拒绝。
//
// 限额(两层中的硬上限层,取安卓数值;pi 截断器管单次输出 50KB/2000 行不动):
// - 读(read/edit 的 readFile):512KB——超限文件引导模型用 bash(sed/head)分段处理,
//   与安卓 WorkspaceTools 口径一致,同时防把大文件整读进内存;
// - 写(write 的 writeFile):2MB。

import { realpathSync } from "node:fs";
import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { ReadOperations } from "./tools/read";
import type { WriteOperations } from "./tools/write";
import type { EditOperations } from "./tools/edit";
import { detectSupportedImageMimeTypeFromFile } from "./tools/mime";
import { formatSize } from "./tools/truncate";

export const READ_HARD_LIMIT_BYTES = 512 * 1024; // 安卓口径:读 512KB
export const WRITE_HARD_LIMIT_BYTES = 2 * 1024 * 1024; // 安卓口径:写 2MB

/** realpath 化;目标不存在时取最深存在祖先的 realpath 拼回剩余段(write 新文件场景)。 */
function canonicalizeWithNonexistentTail(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.slice().reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // 一路到文件系统根都不存在(不可能在合法工作区内),原样拼回交给前缀校验拒绝
        return tail.length === 0 ? current : join(current, ...tail.slice().reverse());
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export class WorkspaceBoundaryError extends Error {
  constructor(path: string, root: string) {
    // 文案面向模型:明确越界即止,不要重试变体
    super(`Access denied: path resolves outside the workspace boundary. Workspace root: ${root}. Requested: ${path}. Only paths inside the workspace can be accessed.`);
    this.name = "WorkspaceBoundaryError";
  }
}

/**
 * 断言绝对路径在工作区边界内,返回 realpath 化的安全路径。
 * @param absolutePath 工具内核 resolveToCwd 算出的绝对路径(可能含软链/不存在的尾段)
 * @param root 工作区边界根(绝对路径)
 */
export function assertInsideWorkspace(absolutePath: string, root: string): string {
  if (absolutePath.includes("\0")) throw new WorkspaceBoundaryError(absolutePath, root);
  const canonicalRoot = canonicalizeWithNonexistentTail(root);
  const canonicalTarget = canonicalizeWithNonexistentTail(absolutePath);
  const rootCmp = comparablePath(canonicalRoot);
  const targetCmp = comparablePath(canonicalTarget);
  // 前缀必须带分隔符:root 自身可放行(cwd=root 合法),兄弟目录(C:\ws vs C:\ws2)拒绝
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep)) {
    throw new WorkspaceBoundaryError(absolutePath, root);
  }
  return canonicalTarget;
}

/** 读取前的体积闸门:超限抛错引导模型分段处理(bash sed/head),防整读进内存。 */
async function readWithHardLimit(safePath: string, displayPath: string): Promise<Buffer> {
  const stat = await fsStat(safePath);
  if (stat.size > READ_HARD_LIMIT_BYTES) {
    throw new Error(
      `File is ${formatSize(stat.size)}, exceeds the ${formatSize(READ_HARD_LIMIT_BYTES)} read limit. Use bash to inspect it in slices, for example: sed -n '1,200p' ${displayPath} or head -c ${READ_HARD_LIMIT_BYTES} ${displayPath}`,
    );
  }
  return fsReadFile(safePath);
}

/** read 工具的有界 Operations:每次操作前过边界断言 + 512KB 读闸门。 */
export function createBoundedReadOperations(root: string): ReadOperations {
  return {
    readFile: (absolutePath) => readWithHardLimit(assertInsideWorkspace(absolutePath, root), absolutePath),
    access: (absolutePath) => fsAccess(assertInsideWorkspace(absolutePath, root), constants.R_OK),
    detectImageMimeType: (absolutePath) => detectSupportedImageMimeTypeFromFile(assertInsideWorkspace(absolutePath, root)),
  };
}

/** write 工具的有界 Operations:边界断言 + 2MB 写闸门;mkdir 同样受界。 */
export function createBoundedWriteOperations(root: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const safePath = assertInsideWorkspace(absolutePath, root);
      const bytes = Buffer.byteLength(content, "utf-8");
      if (bytes > WRITE_HARD_LIMIT_BYTES) {
        throw new Error(
          `Content is ${formatSize(bytes)}, exceeds the ${formatSize(WRITE_HARD_LIMIT_BYTES)} write limit. Write the file in smaller pieces (write a first chunk, then append with bash >> redirection).`,
        );
      }
      await fsWriteFile(safePath, content, "utf-8");
    },
    mkdir: async (dir) => {
      await fsMkdir(assertInsideWorkspace(dir, root), { recursive: true });
    },
  };
}

/** edit 工具的有界 Operations:读走 512KB 闸门(编辑先整读),写走 2MB 闸门。 */
export function createBoundedEditOperations(root: string): EditOperations {
  return {
    readFile: (absolutePath) => readWithHardLimit(assertInsideWorkspace(absolutePath, root), absolutePath),
    writeFile: async (absolutePath, content) => {
      const safePath = assertInsideWorkspace(absolutePath, root);
      const bytes = Buffer.byteLength(content, "utf-8");
      if (bytes > WRITE_HARD_LIMIT_BYTES) {
        throw new Error(
          `Edited content is ${formatSize(bytes)}, exceeds the ${formatSize(WRITE_HARD_LIMIT_BYTES)} write limit.`,
        );
      }
      await fsWriteFile(safePath, content, "utf-8");
    },
    access: (absolutePath) => fsAccess(assertInsideWorkspace(absolutePath, root), constants.R_OK | constants.W_OK),
  };
}
