// api/node-delta.ts — 流式节点帧的增量判定(专题2 H-b,纯函数,单测覆盖)
//
// 问题:node_update 每个 33ms 合并帧都携带完整的、累积增长中的 MessageNode,对流长 N
// 总传输量 O(N²);前端每帧 parse + 整节点替换 → GC churn,与 H-a 高亮叠加时主线程雪上
// 加霜,多标签页(1.5.0)共享流时帧越大放大越狠。
//
// 解法:flush 时把当前节点与"上次已广播指纹"比对——
// - 仅 text/reasoning 的纯前缀增长(该 part 其余字段逐字节一致)→ text_delta 帧,
//   字节量 O(delta);
// - 任何其他变化(part 增删/类型变/工具输入输出/message 增删/selectIndex/元字段)
//   → 全量 node_update 关键帧兜底。
//
// 正确性不依赖"生成只会追加"的假设:是否可增量由逐 part 实测比对决定(startsWith,
// 引擎级 memcmp,300KB ~10µs)。客户端以 baseLen 自校验(容忍快照重叠、拒绝空洞),
// 失配即重订阅拿全量快照——增量帧丢失或错乱永远不会画错,只会退化为一次重同步。

import type { MessageNode } from "../foundation/types";

/** 可增量的 tool part:output 恰为单个 text 条目(bash 部分输出回写的常态形状)。 */
function isStreamableToolPart(part: Record<string, unknown>): boolean {
  if (part.type !== "tool" || !Array.isArray(part.output) || part.output.length !== 1) return false;
  const entry = part.output[0] as Record<string, unknown> | null;
  return !!entry && typeof entry === "object" && !Array.isArray(entry)
    && entry.type === "text" && typeof entry.text === "string";
}

export interface TextDeltaEntry {
  partIndex: number;
  baseLen: number;
  text: string;
}

/** string:可增量的文本载体(value=文本,meta=该 part 其余字段的 JSON);json:整体指纹。 */
type PartShape =
  | { kind: "string"; type: string; value: string; meta: string }
  | { kind: "json"; type: string; value: string };

export interface NodeBroadcastFingerprint {
  messageIds: string;
  selectIndex: number;
  messageId: string;
  parts: PartShape[];
}

/** 对节点当前状态取指纹;结构不可识别(选中 message 缺失等)返回 null → 永远走关键帧。 */
export function fingerprintNode(node: MessageNode): NodeBroadcastFingerprint | null {
  const msg = node.messages[node.selectIndex];
  if (!msg || typeof msg.id !== "string" || !Array.isArray(msg.parts)) return null;
  const parts: PartShape[] = [];
  for (const part of msg.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) return null;
    if (part.type === "text" && typeof part.text === "string") {
      const { text, ...meta } = part;
      parts.push({ kind: "string", type: "text", value: text, meta: JSON.stringify(meta) });
    } else if (part.type === "reasoning" && typeof part.reasoning === "string") {
      const { reasoning, ...meta } = part;
      parts.push({ kind: "string", type: "reasoning", value: reasoning, meta: JSON.stringify(meta) });
    } else if (isStreamableToolPart(part)) {
      // 工作区 bash 流式输出(M2-2):tool part 的 output 为单 text 条目时,把该文本作为
      // 可增量载体,其余字段(input/approvalState/条目 metadata…)全部进 meta 指纹——
      // meta 一变(如截断后挂 details)自动回退关键帧,正确性不依赖追加假设。
      const output = (part as unknown as { output: [{ type: "text"; text: string }] }).output;
      const metaShape = { ...part, output: [{ ...output[0], text: "" }] };
      parts.push({ kind: "string", type: "tool", value: output[0].text, meta: JSON.stringify(metaShape) });
    } else {
      parts.push({ kind: "json", type: String(part.type ?? ""), value: JSON.stringify(part) });
    }
  }
  return {
    messageIds: node.messages.map((m) => m?.id).join("\u0000"),
    selectIndex: node.selectIndex,
    messageId: msg.id,
    parts,
  };
}

/**
 * 比对两个指纹。
 * 返回 null = 不可增量(需 node_update 关键帧);
 * 返回 []   = 与上一帧完全一致(可不发帧);
 * 否则为可直接进 text_delta 帧的增量列表。
 */
export function diffFingerprints(
  prev: NodeBroadcastFingerprint,
  cur: NodeBroadcastFingerprint,
): TextDeltaEntry[] | null {
  if (
    prev.messageIds !== cur.messageIds ||
    prev.selectIndex !== cur.selectIndex ||
    prev.messageId !== cur.messageId ||
    prev.parts.length !== cur.parts.length
  ) {
    return null;
  }
  const deltas: TextDeltaEntry[] = [];
  for (let i = 0; i < cur.parts.length; i++) {
    const a = prev.parts[i]!;
    const b = cur.parts[i]!;
    if (a.kind !== b.kind || a.type !== b.type) return null;
    if (a.kind === "string" && b.kind === "string") {
      if (a.meta !== b.meta) return null;
      if (a.value === b.value) continue;
      if (!b.value.startsWith(a.value)) return null;
      deltas.push({ partIndex: i, baseLen: a.value.length, text: b.value.slice(a.value.length) });
    } else if (a.value !== b.value) {
      return null;
    }
  }
  return deltas;
}
