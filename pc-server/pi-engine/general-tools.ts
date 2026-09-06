// pi-engine/general-tools.ts — 通用工具与 MCP 桥注册为 pi customTools(P4,方案 §3.2/§4.9)
//
// 挂载裁决(§4.9 落定):search_web / scrape_web / save_memory + 按助手启用的 mcp__*。
// 不挂:use_skill(pi 原生 <available_skills> 替代)、get_time_info(有 bash)、
// tts/clipboard/ask_user(v1 收面;ask_user 的挂起语义与 pi 循环冲突,不进工作区会话)。
//
// 根源纪律:一行分发/守卫/审批逻辑都不复刻——
// - 声明:tools/bound 的同一组装配函数(与聊天引擎进模型的 schema 逐字同源);
// - 执行:tools/execution.executeToolCall(搜索开关守卫/MCP OAuth 预刷新/analytics/
//   save_memory 写策略全在其内);
// - 审批:tools/approval.initialApprovalState(MCP 每工具 needsApproval + 助手级
//   override 的既有体系原样生效;search/scrape/memory 恒 auto——与聊天引擎逐字一致)
//   + approval-flow 共享生命周期(与工作区工具同一状态机);
// - 结果:toolResultToParts + realizeToolResult(MCP 图片落盘为 /api/files URL)后,
//   模型面 = openAiToolOutput(与聊天回灌模型的字符串同源),UI 面 = entries 经
//   details.app.output 由事件桥整批还原(part.output 与聊天渲染契约逐字一致)。
//
// jsonl 体积纪律:单 text 条目时 content 即全部信息,不带 details.app(避免大文本
// 在引擎记忆里双写);仅当 entries 含图片/多条目时才带,桥按有无 app 标记选路。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant, Conversation, JsonValue, ToolOutputEntry } from "../foundation/types";
import type { GenerationEventSink } from "../inference-engine/events";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { openAiToolOutput } from "../tools/format";
import { initialApprovalState } from "../tools/approval";
import { gateToolApproval } from "../inference-engine/approval-flow";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

export interface PiGeneralToolsContext {
  conversation: Conversation;
  assistant: Assistant;
  sink: GenerationEventSink;
  /** save_memory 待确认队列的来源标注(当前 ASSISTANT 节点,与聊天路径同口径)。 */
  messageNodeId?: string;
}

/** entries → pi AgentToolResult。模型面文本与聊天引擎 resolvedToolOutput 同源
 *  (openAiToolOutput);UI 面 entries 走 details.app 还原通道。 */
function toGeneralPiToolResult(entries: ToolOutputEntry[]): PiToolResult {
  const text = openAiToolOutput(entries);
  const isPlainSingleText = entries.length === 1 && entries[0]?.type === "text";
  return {
    content: [{ type: "text", text }],
    details: isPlainSingleText ? {} : { app: { output: entries } },
  } as PiToolResult;
}

function buildGeneralTool(
  declaration: { name: string; description: string; parameters: Record<string, unknown> },
  ctx: PiGeneralToolsContext,
): ToolDefinition {
  const { name } = declaration;
  return {
    name,
    label: name,
    description: declaration.description,
    // 无 promptSnippet:不进 pi 系统提示词 Available tools 清单(那里只该有编码工具,
    // 引擎契约原文已有"you may have access to other custom tools"兜底句)——与聊天
    // 引擎"通用工具只出现在 API tools 数组"同构。
    parameters: declaration.parameters as unknown as PiToolParameters,
    // 与工作区工具同为 sequential:审批卡一次一张,MCP 慢调用不并发抢跑。
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, JsonValue>;
      const argsJson = JSON.stringify(args);
      const approval = initialApprovalState(name, ctx.assistant, ctx.conversation, argsJson);
      // 域4-1:通用/MCP 工具审批的摘要——优先 url/query 等可读字段,退化工具名。
      const approvalTarget = args.url ?? args.query ?? args.content ?? args.path ?? args.command;
      const approvalSummary =
        typeof approvalTarget === "string" && approvalTarget.trim() ? approvalTarget.trim().slice(0, 120) : undefined;
      await gateToolApproval(approval, {
        conversationId: ctx.conversation.id,
        toolCallId,
        sink: ctx.sink,
        signal,
        toolName: name,
        ...(approvalSummary ? { summary: approvalSummary } : {}),
      });
      const raw = await executeToolCall(
        { id: toolCallId, function: { name, arguments: argsJson } },
        ctx.assistant,
        {
          conversationId: ctx.conversation.id,
          conversationTitle: ctx.conversation.title,
          messageNodeId: ctx.messageNodeId,
          signal,
        },
      );
      const entries = await realizeToolResult(await toolResultToParts(raw));
      return toGeneralPiToolResult(entries);
    },
  };
}

/** 会话装配入口:声明与聊天引擎同源(openAiSearchTools 带全局开关门控、save_memory
 *  带记忆开关+写策略门控、openAiMcpTools 带服务器/工具双层启用过滤),关掉的面在
 *  这里天然为空——用户没启用 MCP 时 pi 会话零 MCP 工具(§3.2)。 */
export function createPiGeneralTools(ctx: PiGeneralToolsContext): ToolDefinition[] {
  const declarations = [
    ...openAiSearchTools(),
    ...openAiLocalTools(ctx.assistant).filter((tool) => tool.function.name === "save_memory"),
    ...openAiMcpTools(ctx.assistant),
  ];
  return declarations.map((decl) =>
    buildGeneralTool(
      {
        name: String(decl.function.name),
        description: String(decl.function.description ?? ""),
        parameters: (decl.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
      },
      ctx,
    ),
  );
}
