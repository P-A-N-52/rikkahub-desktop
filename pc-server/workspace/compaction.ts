// workspace/compaction.ts — agent 会话压缩的输入构建（方案 §9.8，借 pi CompactionDetails 思想）。
// 职责：①工具 part 折为单行摘要进压缩输入（不折=工具活动被 summaryAsText 静默丢弃，
// "压了个寂寞"）②从被压缩段提取 read/modified 文件与 bash 命令清单，作为结构化状态
// 经 {additional_context} 注入，指示摘要模型保留。纯函数，不触碰会话状态。
// 工具名同时认 pi 原名与安卓别名（跨端导入的会话也能正确压缩）。

import type { JsonValue, Message, ToolPart } from "../foundation/types";
import { isRecord } from "../foundation/utils";

const READ_TOOLS = new Set(["read", "workspace_read_file"]);
const WRITE_TOOLS = new Set(["write", "workspace_write_file"]);
const EDIT_TOOLS = new Set(["edit", "workspace_edit_file"]);
const BASH_TOOLS = new Set(["bash", "workspace_shell"]);

function parseArgs(part: ToolPart): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(part.input || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function str(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolFailed(part: ToolPart): boolean {
  return part.output.some((entry) => isRecord(entry) && typeof (entry as { error?: unknown }).error === "string");
}

function bashExitCode(part: ToolPart): number | null {
  for (const entry of part.output) {
    if (!isRecord(entry) || !isRecord(entry.metadata)) continue;
    const workspace = (entry.metadata as { workspace?: unknown }).workspace;
    if (!isRecord(workspace) || !isRecord(workspace.details)) continue;
    const exitCode = (workspace.details as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number") return exitCode;
  }
  return null;
}

/** 单个工具 part 的一行摘要（压缩输入用；含失败标注，摘要模型据此保留失败线索）。 */
export function toolSummaryLine(part: ToolPart): string {
  const name = part.toolName;
  const args = parseArgs(part);
  const failed = toolFailed(part) ? " (failed)" : "";
  if (READ_TOOLS.has(name)) return `[tool] read ${str(args.path) || "?"}${failed}`;
  if (WRITE_TOOLS.has(name)) return `[tool] write ${str(args.path) || "?"}${failed}`;
  if (EDIT_TOOLS.has(name)) return `[tool] edit ${str(args.path) || "?"}${failed}`;
  if (BASH_TOOLS.has(name)) {
    const command = str(args.command) || "?";
    const exitCode = bashExitCode(part);
    const suffix = exitCode != null ? ` (exit ${exitCode})` : failed;
    return `[tool] $ ${command}${suffix}`;
  }
  return `[tool] ${name}${failed}`;
}

/** summaryAsText 的 agent 口径：text 之外追加工具摘要行（只用于压缩输入，标题/建议不走这里）。 */
export function agentSummaryAsText(msg: Message, textSummary: string): string {
  const lines = msg.parts
    .filter((part): part is ToolPart => isRecord(part) && part.type === "tool")
    .map(toolSummaryLine);
  return lines.length === 0 ? textSummary : `${textSummary}\n${lines.join("\n")}`;
}

export interface AgentActivity {
  readFiles: string[];
  modifiedFiles: string[];
  commands: string[];
}

/** 从被压缩段提取工作区活动清单（去重保序；pi CompactionDetails 的 readFiles/modifiedFiles 思想）。 */
export function extractAgentActivity(messages: Message[]): AgentActivity {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  const commands = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const tool = part as ToolPart;
      const args = parseArgs(tool);
      if (READ_TOOLS.has(tool.toolName)) {
        const path = str(args.path);
        if (path) readFiles.add(path);
      } else if (WRITE_TOOLS.has(tool.toolName) || EDIT_TOOLS.has(tool.toolName)) {
        // 失败的写入不算"已修改"(未落盘),但读取失败仍说明模型关注过该文件,保留。
        const path = str(args.path);
        if (path && !toolFailed(tool)) modifiedFiles.add(path);
      } else if (BASH_TOOLS.has(tool.toolName)) {
        const command = str(args.command);
        if (command) commands.add(command);
      }
    }
  }
  return { readFiles: [...readFiles], modifiedFiles: [...modifiedFiles], commands: [...commands] };
}

const MAX_LIST_ITEMS = 50;

function formatList(items: string[]): string {
  const shown = items.slice(0, MAX_LIST_ITEMS).map((item) => `  - ${item}`);
  if (items.length > MAX_LIST_ITEMS) shown.push(`  - …and ${items.length - MAX_LIST_ITEMS} more`);
  return shown.join("\n");
}

/** 活动清单 → {additional_context} 注入文本；无活动时返回空串（不污染 chat 压缩提示词）。 */
export function buildAgentCompactionContext(activity: AgentActivity): string {
  const sections: string[] = [];
  if (activity.readFiles.length > 0) sections.push(`Files read:\n${formatList(activity.readFiles)}`);
  if (activity.modifiedFiles.length > 0) sections.push(`Files modified:\n${formatList(activity.modifiedFiles)}`);
  if (activity.commands.length > 0) sections.push(`Commands run:\n${formatList(activity.commands)}`);
  if (sections.length === 0) return "";
  return [
    "Workspace activity in the history being summarized. Preserve this state in the summary (files touched, commands run and their outcomes):",
    ...sections,
  ].join("\n");
}
