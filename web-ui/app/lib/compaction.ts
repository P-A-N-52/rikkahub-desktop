// lib/compaction.ts — 压缩边界的展示面判定(纯函数)
// 分割线把"模型的记忆边界"外显:线上的内容对模型只剩摘要,线下才是逐字可见的原文。
// 两种压缩的边界数据形态不同:
//   - 工作区引擎压缩(pi):不重写消息,切点记录在 conversation.engineCompactions
//     ({ cutMessageId, ... }[]),分割线画在切点消息"上方";
//   - 对话模式 UI 压缩:破坏性替换,摘要消息带 { type: "compression_summary" } 注解,
//     分割线画在最后一条摘要"下方"。
// 展示面判定刻意宽松:只要求切点消息仍在会话中,不复刻服务端灌注面的模型编码过滤
// (encodesToEntries)——那是上下文构建的严格校验,画线不需要。
import type { UIMessage } from "~/types";

/** 从 engineCompactions 原始记录中取展示用切点:切点消息仍存在的最新一条。 */
export function effectiveCompactionCutId(
  engineCompactions: unknown,
  presentMessageIds: ReadonlySet<string>,
): string | null {
  if (!Array.isArray(engineCompactions)) return null;
  for (let i = engineCompactions.length - 1; i >= 0; i--) {
    const record = engineCompactions[i];
    if (!record || typeof record !== "object") continue;
    const cutMessageId = (record as { cutMessageId?: unknown }).cutMessageId;
    if (typeof cutMessageId === "string" && presentMessageIds.has(cutMessageId)) return cutMessageId;
  }
  return null;
}

/** 对话模式 UI 压缩的摘要消息(auxiliary.ts 落库时打注解)。 */
export function isCompressionSummaryMessage(message: Pick<UIMessage, "annotations">): boolean {
  return (message.annotations ?? []).some((annotation) => annotation.type === "compression_summary");
}
