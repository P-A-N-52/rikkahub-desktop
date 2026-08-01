// workspace/approval.ts — 工作区审批矩阵与危险命令识别(纯函数层)
// 纪律:零依赖纯函数(词法路径运算,不碰文件系统),便于单测与在 tools/approval.ts 内联使用。
//
// 三档语义(2026-08-01 用户拍板改版):
//   confirm_each(询问批准):write/edit/bash 恒审批;read 免审。
//   balanced(默认权限):区内 write/edit 免审(类比安卓 /tmp 豁免:区内写入低风险);
//     bash 仅危险命令审批;write/edit 目标在工作区边界外 → 审批。
//   full_access(完全访问):全部免审,不受限制操作电脑文件(系统目录仍硬拒,boundary.ts)。
//
// 两段式审批判定(取代旧"只依赖工具名+档位"不变量,§9.3 修订):
//   建卡态 = 无参数下界 workspaceToolNeedsApproval(tool, preset)——Claude 流式在
//   content_block_start 参数未到时用它建卡;
//   终局 = 参数齐备后的 workspaceCallApprovalReason(tool, preset, args, ctx)——
//   批内预扫描用它,循环层把 auto→pending 的上调经 tool_approval_updated 事件同步回卡。
//   单调性是硬前提:下界为 pending 的组合终局必为 pending,卡永不 pending→auto 降级。
// 词法判定看不出的逃逸(软链指向区外等)不产生审批漏洞:未经批准的执行走严界
// Operations(boundary.ts realpath 断言),照样被拒。

import { isAbsolute, resolve, sep } from "node:path";
import type { JsonValue, WorkspacePermissionPreset } from "../foundation/types";
import { resolveToCwd } from "./tools/path-utils";

export const WORKSPACE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

/** 无参数下界(建卡态):只有 confirm_each 的非 read 工具能在参数未到时断定要审批。 */
export function workspaceToolNeedsApproval(tool: WorkspaceToolName, preset: WorkspacePermissionPreset): boolean {
  if (tool === "read") return false;
  return preset === "confirm_each";
}

/** 词法越界判定:与 boundary.ts 同前缀语义(Windows 大小写不敏感),但不做 realpath。 */
function isLexicallyOutsideRoot(absolutePath: string, root: string): boolean {
  const cmp = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = cmp(resolve(absolutePath));
  const rootCmp = cmp(resolve(root));
  return target !== rootCmp && !target.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep);
}

/** 会话 cwd 的词法解析(与 runtime.resolveCwd 同语义,少一步存在性自愈——审批判定不碰 fs)。 */
export function lexicalWorkspaceCwd(root: string, workspaceCwd: string | null | undefined): string {
  const raw = String(workspaceCwd ?? "").trim();
  if (!raw) return root;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  return isLexicallyOutsideRoot(absolute, root) ? root : absolute;
}

export interface WorkspaceCallContext {
  /** 工作区边界根(绝对路径) */
  root: string;
  /** 会话工作目录(相对参数路径按此解析,恒在 root 内) */
  cwd: string;
}

/** 参数齐备后的终局判定。返回 null=免审;返回字符串=需审批,非空串是给审批卡的缘由
 *  (英文,与工具错误文案同语言),空串=档位恒审批、无需附加说明。 */
export function workspaceCallApprovalReason(
  tool: WorkspaceToolName,
  preset: WorkspacePermissionPreset,
  args: Record<string, JsonValue>,
  ctx: WorkspaceCallContext,
): string | null {
  if (tool === "read" || preset === "full_access") return null;
  if (preset === "confirm_each") return "";
  if (tool === "bash") {
    const reason = findDangerousCommandReason(String(args.command ?? ""));
    return reason ? `Destructive command pattern: ${reason}` : null;
  }
  // balanced 档 write/edit:目标在边界外 → 审批。路径解析用与工具内核同一 resolveToCwd
  // (含 ~ 展开),保证审批眼中的目标与实际写入目标一致;形状残缺(path 缺失)不挂审批,
  // 交给内核按 schema 报错回灌模型。
  const raw = args.path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const resolved = resolveToCwd(raw, ctx.cwd);
  return isLexicallyOutsideRoot(resolved, ctx.root)
    ? `Writes outside the workspace: ${resolved}`
    : null;
}

// 危险命令静态拦截清单。目标是灾难性、不可逆的系统级破坏(整盘/设备/系统目录),
// 不是细粒度沙箱(shell 天然可越界是全行业现状,§七-1 已向用户明示)。
// 每项 [正则, 人话说明];说明会出现在拦截错误文案里,模型与用户都看得懂。
// 目标 token 结束判定:后随空白/行尾/命令分隔符(允许 rm -rf / --no-preserve-root 这种带尾部旗标的形态)。
// 命令位判定:mkfs/diskpart 等裸命令要求出现在行首、分隔符后或 sudo 后,避免误伤 grep 'mkfs' 之类字面量引用。
const DANGEROUS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // rm -rf 指向根/家目录/盘符根(允许 rm -rf ./build 这类区内清理)
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)(\/|~|\$HOME)\2(?=\s|$|[;&|)])/, "recursive force-delete of the filesystem root or home directory"],
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)\/(bin|boot|dev|etc|lib|proc|sys|usr|var)\b/, "recursive force-delete of a system directory"],
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/, "recursive force-delete of a drive root"],
  // Windows 整盘/系统目录删除(Git Bash 下也可能调 cmd /c del)
  [/\bdel\s+(\/[a-zA-Z]\s+)*\/s\b.*\s(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/i, "recursive delete of a drive root (del /s)"],
  [/\b(rd|rmdir)\s+\/s\b.*\s(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/i, "recursive removal of a drive root (rd /s)"],
  // 磁盘/文件系统毁灭(命令位判定)
  [/(?:^|[;&|(]\s*|\bsudo\s+)mkfs(\.\w+)?\b/, "filesystem format (mkfs)"],
  [/\bformat(\.com)?\s+[A-Za-z]:/i, "drive format"],
  [/(?:^|[;&|(]\s*|\bsudo\s+)diskpart\b/i, "disk partitioning tool (diskpart)"],
  [/\bdd\b[^;&|]*\bof=\/dev\/(sd[a-z]|hd[a-z]|nvme\d+n\d+|disk\d+)\b/, "raw write to a block device (dd)"],
  [/>\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d+n\d+)\b/, "raw write to a block device"],
  // 系统级权限破坏 / 注册表删除
  [/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]{3,4}\s+\/\s*(?:$|[;&|)])/, "recursive permission change on filesystem root"],
  [/\breg\s+delete\s+(["']?)HK(LM|EY_LOCAL_MACHINE)\b/i, "registry hive deletion (HKLM)"],
  // fork 炸弹
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, "fork bomb"],
];

/** 命中返回人话说明(进拦截文案),未命中返回 null。 */
export function findDangerousCommandReason(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return null;
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}
