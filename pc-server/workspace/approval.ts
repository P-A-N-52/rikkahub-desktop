// workspace/approval.ts — 工作区审批矩阵与危险命令拦截(M1-4,纯函数层)
// 纪律:零依赖纯函数,便于单测与在 tools/approval.ts 内联使用。
//
// 审批一致性不变量(§9.3):审批判定只依赖 (工具名, 档位),绝不依赖工具参数——
// Claude/Google 流式路径在 content_block_start 建卡时参数尚未到齐,若审批依赖参数,
// 建卡态与批内预扫描(tool-loop.ts:289)会不一致,导致"卡显示免审但整批被挂起"的死局。
// 因此危险命令拦截不走审批态,而在执行层(runtime.ts)拦:未经用户显式批准(userApproved)
// 的危险命令直接拒绝执行,错误文案回灌模型;confirm_each/balanced 档 bash 恒审批,
// 用户批准后即视为知情同意放行——这正是方案 §3.2"完全访问=免审(危险命令仍拦截)"的语义。

import type { WorkspacePermissionPreset } from "../foundation/types";

export const WORKSPACE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

/** 审批矩阵(§3.2):read 恒免审;write/edit 仅 confirm_each 审批;bash 仅 full_access 免审。 */
export function workspaceToolNeedsApproval(tool: WorkspaceToolName, preset: WorkspacePermissionPreset): boolean {
  if (tool === "read") return false;
  if (tool === "bash") return preset !== "full_access";
  return preset === "confirm_each";
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
