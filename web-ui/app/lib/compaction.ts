// lib/compaction.ts — 压缩边界的展示面判定(纯函数)
// 分割线锚定"压缩发生时刻的最新一条消息"(用户发起 /compact 的位置),画在该消息
// 下方——线上的会话已被压缩处理。标记由服务端压缩完成时落库(对话模式 auxiliary.ts
// markCompactionBoundary / 工作区 orchestrator applyCapturedEngineCompactions 同一 helper),
// 两种压缩形态(pi 切点记录 / UI 历史替换)在展示面收敛为同一个注解。
import type { UIMessage } from "~/types";

/** 压缩发生点消息:分割线画在它下方。 */
export function isCompactionBoundaryMessage(message: Pick<UIMessage, "annotations">): boolean {
  return (message.annotations ?? []).some((annotation) => annotation.type === "compaction_boundary");
}
