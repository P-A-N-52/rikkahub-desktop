// lib/workspace-tool-model.ts — 工作区工具 part 的纯数据模型(无 React/无 UI 依赖)。
//
// 从 workspace-tool-part.tsx 抽出:消息分组(lib/message-grouping.ts)需要在渲染前
// 判定"动作是否失败",不能反向依赖组件模块;纯函数落此也让 bun test 可直测。
// 渲染 100% 由 part 数据驱动(input/output/metadata.workspace),无前端私有状态——
// 备份互通的两个方向都不降级:PC 存 pi 原样;安卓导入的 workspace_* 四个别名
// toolName 在此注册,同样原生渲染。

import type { ToolPart } from "~/types";

export type WorkspaceToolKind = "read" | "write" | "edit" | "bash";

const KIND_BY_TOOL_NAME: Record<string, WorkspaceToolKind> = {
  // pi 原名(PC 原生)
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  // 安卓别名(备份导入,§9.1B)
  workspace_read_file: "read",
  workspace_write_file: "write",
  workspace_edit_file: "edit",
  workspace_shell: "bash",
};

export function workspaceToolKind(toolName: string): WorkspaceToolKind | null {
  return KIND_BY_TOOL_NAME[toolName] ?? null;
}

/** write/edit/bash 是"改变世界"的动作;read 是只读侦察,恒留思维链折叠组。 */
export function isWorkspaceActionTool(toolName: string): boolean {
  const kind = workspaceToolKind(toolName);
  return kind !== null && kind !== "read";
}

// ===== part 数据抽取(全部防御式:安卓导入的 args 键名可能有别) =====

export function parseArgs(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function strField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function numField(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** M1 契约:结构化 details 挂首个 text 输出条目的 metadata.workspace.details。 */
export function workspaceDetails(tool: ToolPart): Record<string, unknown> | null {
  for (const entry of tool.output) {
    if (!entry || typeof entry !== "object") continue;
    const meta = (entry as { metadata?: unknown }).metadata;
    if (!meta || typeof meta !== "object") continue;
    const workspace = (meta as Record<string, unknown>).workspace;
    if (!workspace || typeof workspace !== "object") continue;
    const details = (workspace as Record<string, unknown>).details;
    if (details && typeof details === "object") return details as Record<string, unknown>;
  }
  return null;
}

export function outputText(tool: ToolPart): string {
  return tool.output
    .filter((entry): entry is { type: "text"; text: string } =>
      Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text"),
    )
    .map((entry) => entry.text)
    .join("\n");
}

export function outputError(tool: ToolPart): string | null {
  for (const entry of tool.output) {
    if (entry && typeof entry === "object" && typeof (entry as { error?: unknown }).error === "string") {
      return (entry as { error: string }).error;
    }
  }
  return null;
}

/** bash 结构化退出码(details.exitCode);未终局或非 bash 输出为 null。 */
export function workspaceExitCode(tool: ToolPart): number | null {
  const details = workspaceDetails(tool);
  const value = details?.exitCode;
  return typeof value === "number" ? value : null;
}

/** 动作终局失败判定的唯一真源:被拒/错误载荷/bash 非零退出。
 *  刻意不碰 outputText(可能是数百 KB 终端输出)——分组层每个流式 delta 都要
 *  对全部 part 重算,本函数必须保持 O(output条数) 的字段访问,零解析零拼接。 */
function terminalFailure(tool: ToolPart, kind: WorkspaceToolKind): boolean {
  if (tool.approvalState.type === "denied") return true;
  if (tool.output.length === 0) return false;
  if (outputError(tool) !== null) return true;
  if (kind === "bash") {
    const exitCode = workspaceExitCode(tool);
    return exitCode !== null && exitCode !== 0;
  }
  return false;
}

/** 消息分组用:失败的工作区动作(write/edit/bash)抽出思维链成独立卡。
 *  语义(抽屉合并方案,用户 2026-09-05 拍板):抽出=需要用户注意(待审批/失败),
 *  例行成功的动作与思维链同折叠;read 恒不抽出。 */
export function isFailedWorkspaceAction(tool: ToolPart): boolean {
  const kind = workspaceToolKind(tool.toolName);
  if (kind === null || kind === "read") return false;
  return terminalFailure(tool, kind);
}

// ===== 动作卡/动作步骤共用的视图模型 =====

export interface WorkspaceActionModel {
  kind: WorkspaceToolKind;
  args: Record<string, unknown>;
  details: Record<string, unknown> | null;
  text: string;
  error: string | null;
  denied: boolean;
  deniedReason: string;
  /** 是否已有终局结果(bash 以结构化 exitCode 到位为准,其余以任何输出到位为准)。 */
  finished: boolean;
  exitCode: number | null;
  /** 终局失败(被拒/错误/非零退出);与 isFailedWorkspaceAction 同源。 */
  failed: boolean;
}

export function buildWorkspaceActionModel(tool: ToolPart): WorkspaceActionModel {
  const kind = workspaceToolKind(tool.toolName) ?? "bash";
  const args = parseArgs(tool.input);
  const details = workspaceDetails(tool);
  const error = outputError(tool);
  const denied = tool.approvalState.type === "denied";
  const deniedReason = tool.approvalState.type === "denied" ? (tool.approvalState.reason ?? "") : "";
  const exitCode = details && typeof details.exitCode === "number" ? details.exitCode : null;
  const finished =
    denied || error !== null || (kind === "bash" ? details !== null && "exitCode" in details : tool.output.length > 0);
  return {
    kind,
    args,
    details,
    text: outputText(tool),
    error,
    denied,
    deniedReason,
    finished,
    exitCode,
    failed: terminalFailure(tool, kind),
  };
}
