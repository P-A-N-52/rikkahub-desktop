// inference-engine/events.ts — 生成事件流与工具执行接口
// 纪律：本文件只定义类型与回调契约，不写具体实现，避免被 server.ts 的细节污染。

import type { JsonValue, Message, StreamHooks, ToolApprovalState, ToolOutputEntry } from "../foundation/types";

/** 生成过程中产生的单个事件。协调器（generateAnswer）根据这些事件更新消息、
 *  持久化状态和广播 SSE；推理引擎本身不直接执行副作用。 */
export type GenerationEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string; metadata?: Record<string, JsonValue> }
  | { kind: "image_delta"; url: string; metadata?: Record<string, JsonValue> }
  | {
      kind: "tool_call_created";
      toolCallId: string;
      toolName: string;
      input: string;
      approvalState: ToolApprovalState;
    }
  | { kind: "tool_input_delta"; toolCallId: string; input: string }
  // 审批态上调同步:流内建卡(参数未到)给的是无参数下界,批内预扫描参数齐备后
  // 若终局为 pending,循环层发此事件把卡从 auto 上调(带缘由)。只升不降。
  | { kind: "tool_approval_updated"; toolCallId: string; approvalState: ToolApprovalState }
  | { kind: "tool_result"; toolCallId: string; output: ToolOutputEntry[] }
  | { kind: "usage"; usage: Message["usage"] }
  | { kind: "finished"; content: string; stopReason: string | null }
  | { kind: "error"; error: string }
  | { kind: "abort" };

/** 事件接收器。Provider 流式函数在解析到增量时调用它。 */
export type GenerationEventSink = (event: GenerationEvent) => void;

/** 与 Provider API 对齐的工具调用描述。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 传给工具执行的上下文信息。tracing / 记忆来源之外，M1-4 起承载工作区执行语境：
 *  signal 由协调器注入（bash 取消杀进程树的前提）；userApproved 仅在审批恢复路径
 *  为 true（危险命令拦截的知情同意放行门，workspace/runtime.ts）。 */
export interface ToolContext {
  conversationId?: string;
  conversationTitle?: string;
  messageNodeId?: string;
  signal?: AbortSignal;
  userApproved?: boolean;
  /** 执行中部分输出回写（bash 流式输出，M1-5）：写回当前 tool part 的 output，
   *  走现有 node_update 关键帧管线（pi 内核 100ms 节流 + touchStream 33ms 合帧）。 */
  onToolPartialOutput?: (output: ToolOutputEntry[]) => void;
}

/** 工具执行的标准化返回值。
 *  - output: 要显示在对话里的 UI parts。
 *  - fileCreation: 工具想创建文件（如 MCP 图片）时返回的描述符，
 *    由协调器统一落盘，避免工具直接修改 global state.files。 */
export interface ToolResult {
  output: ToolOutputEntry[];
  /** 工具想创建的文件描述符列表（如 MCP 图片）。由协调器统一落盘，避免工具直接修改 global state.files。 */
  fileCreations?: Array<{ data: string; mime: string; prefix: string }>;
}

/** 推理引擎对工具执行层的抽象。实现可以暂时仍是 server.ts 里的 executeToolCall，
 *  但接口保证二者不形成循环 import。 */
export type ToolExecutor = (toolCall: ToolCall, context?: ToolContext) => Promise<ToolResult>;

/** 流式钩子的事件下沉扩展。推理引擎通过 sink 发出事件，由协调器（generateAnswer）
 *  应用到 message 并触发持久化/SSE；executeTool 是注入的工具执行回调。 */
export type StreamHooksWithSink = StreamHooks & {
  sink?: GenerationEventSink;
  executeTool?: ToolExecutor;
};

/** 工具调度上下文：在工具执行回调外再包一层 executeTool 引用，
 *  让 Provider 函数无需直接 import server.ts 的 executeToolCall。 */
export type ToolDispatchContext = ToolContext & { executeTool?: ToolExecutor };
