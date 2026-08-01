// tools/approval.ts — 工具审批状态判断
// 纪律：纯函数，只读取 assistant / settings / 工作区档位，不读写 state 运行时副作用。
// M1-4：workspace 工具（read/write/edit/bash）按会话绑定工作区的 permissionPreset 走
// 审批矩阵（workspace/approval.ts 纯函数）。判定只依赖 (工具名, 档位)，不依赖参数——
// 这是流式建卡态与批内预扫描一致性的硬前提（见 workspace/approval.ts 头注）。

import { getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, Conversation, ToolApprovalState } from "../foundation/types";
import { state } from "../persistence/json-store";
import { isWorkspaceToolName, workspaceToolNeedsApproval } from "../workspace/approval";
import { getWorkspace } from "../workspace";

export function getMcpToolOverride(
  assistant: Assistant,
  serverId: string,
  toolName: string,
): { enable?: boolean; needsApproval?: boolean } | undefined {
  const overrides = isRecord(assistant.mcpToolOverrides)
    ? (assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>)
    : undefined;
  if (!overrides) return undefined;
  const perServer = overrides[serverId];
  if (!perServer) return undefined;
  return perServer[toolName];
}

// Per-assistant resolved enable state for a tool. Global tool.enable=false ⇒ false (override
// can never reactivate a globally-disabled tool — matches the user's stated rule "设置中关闭
// 的工具会话里看不见"). Otherwise, the override.enable wins; absence falls back to true.
export function isMcpToolEnabledForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  if (tool.enable === false) return false;
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (override?.enable === false) return false;
  return true;
}

// Per-assistant resolved needsApproval state. Override wins when set (true/false), otherwise
// falls back to the global per-tool needsApproval flag.
export function isMcpToolApprovalRequiredForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (typeof override?.needsApproval === "boolean") return override.needsApproval;
  return tool.needsApproval === true;
}

// Returns true if this tool requires user approval before executing — mirrors Android's
// GenerationHandler.kt:184-189 logic (`toolDef?.needsApproval == true && state is Auto -> Pending`).
// PC scope: `ask_user` is always pending (it's literally a "ask the user" prompt), and any
// MCP tool whose effective needsApproval (override-resolved) is true gets pending too. Local
// built-ins (search/scrape/memory/etc.) currently never need approval — Android matches.
export function toolNeedsApproval(
  toolName: string,
  assistant: Assistant,
  conversation?: Pick<Conversation, "workspaceId"> | null,
): boolean {
  if (!toolName) return false;
  if (toolName === "ask_user") return true;
  if (isWorkspaceToolName(toolName)) {
    // 工作区工具只在 workspaceId 非空的会话挂载；非工作区会话的残留调用在
    // 执行层被拒（workspace/runtime.ts 守卫），这里不挂审批。工作区记录丢失
    // → 按最严档处理（同样会在执行层拒掉，pending 卡只是多一道门）。
    const workspaceId = conversation?.workspaceId;
    if (!workspaceId) return false;
    const preset = getWorkspace(workspaceId)?.permissionPreset ?? "confirm_each";
    return workspaceToolNeedsApproval(toolName, preset);
  }
  if (!toolName.startsWith("mcp__")) return false;
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as Array<Record<string, unknown>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, unknown>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find(
      (tool) =>
        isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
        && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (matched) return isMcpToolApprovalRequiredForAssistant(assistant, String(server.id ?? ""), matched);
  }
  return false;
}

export function initialApprovalState(
  toolName: string,
  assistant: Assistant,
  conversation?: Pick<Conversation, "workspaceId"> | null,
): ToolApprovalState {
  return toolNeedsApproval(toolName, assistant, conversation) ? { type: "pending" } : { type: "auto" };
}
