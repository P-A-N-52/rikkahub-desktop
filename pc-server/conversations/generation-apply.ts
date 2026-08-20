// conversations/generation-apply.ts — GenerationEvent → 消息 parts 的唯一写入字典
//
// P2(pi 引擎)抽取自 generateAnswer 的内联 applyEvent,逐字搬迁、行为零变。
// 抽取动机:这是"生成事件如何落到 Message.parts + 持久化/SSE"的权威语义,聊天引擎
// (orchestrator 的 sink)与 pi 事件桥(pi-engine/event-bridge → 本应用器)必须同源——
// 两套写入逻辑必然漂移,漂移即渲染/落库分叉。桥契约测试也经本模块回放,测的是真实写入。
//
// 纪律:本模块只写传入的 message/conversation/node 与 touchStream(标脏+节流落库+合帧
// 广播),不碰全局 state、不直接落库、不直接广播——与原 applyEvent 完全一致。

import type { Conversation, Message, MessageNode, StreamHooks } from "../foundation/types";
import type { GenerationEvent, GenerationEventSink, StreamHooksWithSink } from "../inference-engine/events";
import { isRecord } from "../foundation/utils";
import { touchStream } from "../api/sse";
import { mergeTokenUsage } from "../inference-engine/tool-loop";
import {
  addStreamImage,
  addStreamText,
  appendReasoningDelta,
  finishReasoningParts,
  replaceLoadingReasoningWithTool,
} from "../inference-engine/parts";

export interface GenerationApplyTarget {
  conversation: Conversation;
  node: MessageNode;
  message: Message;
}

/** 构造把 GenerationEvent 应用到指定消息的应用器。语义与 generateAnswer 原内联
 *  applyEvent 逐字一致(含各 case 的幂等与"只升不降"审批规则),见各分支注释。 */
export function createGenerationEventApplier(target: GenerationApplyTarget): GenerationEventSink {
  const { conversation, node, message: currentMessage } = target;
  return (event: GenerationEvent) => {
    const streamHooks: StreamHooks = { message: currentMessage, conversation, node };
    switch (event.kind) {
      // 文本/思维链/图片增量写入内存后必须 touchStream(标脏 + 200ms 节流落库 + 33ms 节流
      // 广播),与下方三个 tool case 对齐。5.3g 搬迁时该调用曾丢失(收官审查 P0-2):无工具
      // 会话全程无增量帧、无增量落库,流式中崩溃丢整段回答。
      case "text_delta":
        addStreamText(streamHooks, event.text);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "reasoning_delta":
        appendReasoningDelta(streamHooks as StreamHooksWithSink, event.text, event.metadata);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "image_delta":
        addStreamImage(streamHooks, event.url, event.metadata);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_call_created": {
        finishReasoningParts(currentMessage);
        // 幂等化:OpenAI 系流内建卡(参数未齐的下界)后,循环层读完整轮还会发一次
        // 终局建卡事件——已有同 id 卡时改为更新参数与审批态(只升不降:auto/pending
        // 可被终局覆盖,用户已决定的 approved/denied 不回写),不再追加重复卡。
        const exists = currentMessage.parts.some(
          (part) => isRecord(part) && part.type === "tool" && part.toolCallId === event.toolCallId,
        );
        if (exists) {
          currentMessage.parts = currentMessage.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
            const current = isRecord(part.approvalState) ? String(part.approvalState.type ?? "") : "";
            return {
              ...part,
              ...(event.input ? { input: event.input } : {}),
              ...(current === "auto" || current === "pending" ? { approvalState: event.approvalState } : {}),
            };
          });
        } else {
          replaceLoadingReasoningWithTool(currentMessage, {
            type: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: [],
            approvalState: event.approvalState,
          });
        }
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      }
      case "tool_input_delta":
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          return { ...part, input: event.input };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_approval_updated":
        // 审批态上调同步(流内建卡的无参数下界 → 参数齐备后的终局)。只改 auto/pending
        // 态的卡,绝不回写用户已决定的 approved/denied。
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          const current = isRecord(part.approvalState) ? String(part.approvalState.type ?? "") : "";
          if (current !== "auto" && current !== "pending") return part;
          return { ...part, approvalState: event.approvalState };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_result":
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          return { ...part, output: event.output };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "usage":
        // P1-3:多轮工具调用时每轮都发 usage 事件,merge 防后轮缺字段清零已知值。
        currentMessage.usage = mergeTokenUsage(currentMessage.usage, event.usage);
        break;
      // finished/error/abort:终局语义由生成入口(generateAnswer / pi runner 的返回与
      // 抛错)承载,不经应用器——与原内联 applyEvent 一致(其 switch 亦无这三个 case)。
      case "finished":
      case "error":
      case "abort":
        break;
    }
  };
}
