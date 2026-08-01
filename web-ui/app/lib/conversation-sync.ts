// 会话详情 SSE 增量应用(FE-P1-3:从 routes/conversations.tsx 原样迁出以便单测)。
// 这是流式渲染的核心数据通路:
// - node_update(关键帧)携带完整节点,整节点替换;
// - text_delta(专题2 H-b)只携带 text/reasoning 的追加文本,就地追加——未触及的
//   节点/message 保持引用身份,契合细粒度订阅;
// - 窗口化快照(专题2 I-2)只携带最近若干节点 + 全量内容戳清单 nodeStamps,这里
//   负责把本地已加载的更早节点做"可验证前缀合并":逐节点比对内容戳,一致才保留,
//   不一致即丢弃(向上滚动时经 nodes 分片端点重拉)——永不猜测,失配只退化为重拉。
// 行为契约见测试 conversation-sync.test.ts。
import type {
  ConversationDto,
  ConversationNodesPageDto,
  ConversationNodeUpdateEventDto,
  ConversationTextDeltaEventDto,
  MessagePart,
} from "~/types";

export function applyNodeUpdate(
  conversation: ConversationDto,
  event: ConversationNodeUpdateEventDto,
): ConversationDto {
  if (conversation.id !== event.conversationId) {
    return conversation;
  }

  const offset = conversation.nodesOffset ?? 0;
  const nextNodes = [...conversation.messages];
  const nextStamps = conversation.nodeStamps ? [...conversation.nodeStamps] : undefined;
  const indexById = nextNodes.findIndex((node) => node.id === event.nodeId);
  let absIndex: number;

  if (indexById >= 0) {
    nextNodes[indexById] = event.node;
    absIndex = offset + indexById;
  } else {
    if (event.nodeIndex < 0) {
      return conversation; // 防御异常帧
    }
    if (event.nodeIndex < offset) {
      // I-2:窗口下方的未加载节点(如老消息的翻译)。节点本体不落地——向上翻页时
      // 会从权威实例拿到新版;只把清单里的内容戳换新,后续窗口化快照合并才不会
      // 把它的旧版本当作"仍然一致"保留。
      if (nextStamps && event.nodeIndex < nextStamps.length) {
        nextStamps[event.nodeIndex] = event.stamp;
        return {
          ...conversation,
          nodeStamps: nextStamps,
          updateAt: event.updateAt,
          isGenerating: event.isGenerating,
        };
      }
      return { ...conversation, updateAt: event.updateAt, isGenerating: event.isGenerating };
    }
    const local = event.nodeIndex - offset;
    if (local < nextNodes.length) {
      nextNodes[local] = event.node; // id 未命中时按(换算后的)下标替换
    } else {
      nextNodes.push(event.node); // 追加;下标越过长度也追加(帧乱序到达不丢内容)
    }
    absIndex = offset + Math.min(local, nextNodes.length - 1);
  }

  if (nextStamps) {
    while (nextStamps.length < absIndex) nextStamps.push(""); // 乱序帧的空洞占位,永不匹配 → 保守
    nextStamps[absIndex] = event.stamp;
  }

  return {
    ...conversation,
    messages: nextNodes,
    ...(nextStamps ? { nodeStamps: nextStamps } : {}),
    updateAt: event.updateAt,
    isGenerating: event.isGenerating,
  };
}

/** mergeConversationSnapshot 的结果:合并后的详情 + 需要后台修复的陈旧绝对下标区间。 */
export interface SnapshotMergeResult {
  detail: ConversationDto;
  /** [from, to) 内的本地节点内容已与服务端分叉(保留旧版渲染,等分片重拉替换);null = 无需修复。 */
  staleRange: { from: number; to: number } | null;
}

/**
 * 窗口化快照合并(专题2 I-2)。
 * 快照携带 [nodesOffset, total) 的节点与全量清单;本地已加载的更早节点从窗口起点
 * 向前逐个比对内容戳,一致段保持对象身份直接保留。
 *
 * 失配段不再原地丢弃:react-virtuoso 不支持 firstItemIndex 原地增大(内测 bug1——
 * 已挂载列表被就地截短后尺寸树错乱,底部出现幽灵空白、尾部节点消失)。改为整个
 * 前缀原样保留(nodesOffset 不抬升),失配区间以 staleRange 报给调用方,由
 * conversation-stream 经分片端点重拉新版原地替换——短暂展示旧版内容,永不画错结构。
 * 失配段清单保留本地旧戳(清单必须反映本地真实版本,修复落地前的后续合并才能持续
 * 识别出该区间仍陈旧)。
 *
 * 本地已加载段接不上新窗口起点(离开期间追加超过一个窗口,中间有空洞)、全量快照
 * (nodesOffset 0/缺省)或本地无清单时,原样采用新快照——此时 offset 可能原地增大,
 * 视图层以重挂载兜底(conversations.tsx)。
 */
export function mergeConversationSnapshot(
  existing: ConversationDto | null,
  incoming: ConversationDto,
): SnapshotMergeResult {
  const inOffset = incoming.nodesOffset ?? 0;
  if (inOffset === 0 || !existing || existing.id !== incoming.id) {
    return { detail: incoming, staleRange: null };
  }
  const exOffset = existing.nodesOffset ?? 0;
  const exStamps = existing.nodeStamps;
  const inStamps = incoming.nodeStamps;
  if (!exStamps || !inStamps || exOffset >= inOffset) return { detail: incoming, staleRange: null };
  if (exOffset + existing.messages.length < inOffset) return { detail: incoming, staleRange: null };

  let keepStart = inOffset;
  while (keepStart > exOffset) {
    const abs = keepStart - 1;
    const localNode = existing.messages[abs - exOffset];
    const stamp = exStamps[abs];
    if (!localNode || !stamp || stamp !== inStamps[abs]) break;
    keepStart = abs;
  }

  const detail: ConversationDto = {
    ...incoming,
    messages: [...existing.messages.slice(0, inOffset - exOffset), ...incoming.messages],
    nodesOffset: exOffset,
  };
  if (keepStart === exOffset) return { detail, staleRange: null };

  const nextStamps = [...inStamps];
  for (let abs = exOffset; abs < keepStart; abs++) {
    nextStamps[abs] = exStamps[abs] ?? "";
  }
  detail.nodeStamps = nextStamps;
  return { detail, staleRange: { from: exOffset, to: keepStart } };
}

/**
 * 向上翻页分片拼接(专题2 I-2)。分片必须与当前窗口紧邻(page.offset + 节点数 ==
 * 本地 nodesOffset),否则说明拼接期间本地状态已被新快照推进 → "stale",调用方重拉。
 * 分片来自权威实例,其内容戳直接覆盖清单对应区间。
 */
export function prependOlderNodes(
  conversation: ConversationDto,
  page: ConversationNodesPageDto,
): ConversationDto | "stale" {
  const offset = conversation.nodesOffset ?? 0;
  if (offset === 0 || page.nodes.length === 0) return "stale";
  if (page.offset + page.nodes.length !== offset) return "stale";
  const nextStamps = conversation.nodeStamps ? [...conversation.nodeStamps] : undefined;
  if (nextStamps) {
    for (let i = 0; i < page.stamps.length; i++) {
      const stamp = page.stamps[i];
      if (stamp !== undefined) nextStamps[page.offset + i] = stamp;
    }
  }
  return {
    ...conversation,
    messages: [...page.nodes, ...conversation.messages],
    nodesOffset: page.offset,
    ...(nextStamps ? { nodeStamps: nextStamps } : {}),
  };
}

/**
 * 陈旧区间修复:把分片端点拉回的权威节点原地替换进已加载窗口(不改长度/offset,
 * 对 Virtuoso 是纯内容更新)。分片必须整体落在本地已加载区间内,越界即 "stale"
 * (修复期间窗口被新快照推进,调用方放弃本轮,下一次快照会重新标脏)。
 */
export function replaceNodesRange(
  conversation: ConversationDto,
  page: ConversationNodesPageDto,
): ConversationDto | "stale" {
  const offset = conversation.nodesOffset ?? 0;
  if (page.nodes.length === 0) return "stale";
  if (page.offset < offset) return "stale";
  if (page.offset + page.nodes.length > offset + conversation.messages.length) return "stale";
  const nextNodes = [...conversation.messages];
  for (let i = 0; i < page.nodes.length; i++) {
    nextNodes[page.offset - offset + i] = page.nodes[i]!;
  }
  const nextStamps = conversation.nodeStamps ? [...conversation.nodeStamps] : undefined;
  if (nextStamps) {
    for (let i = 0; i < page.stamps.length; i++) {
      const stamp = page.stamps[i];
      if (stamp !== undefined) nextStamps[page.offset + i] = stamp;
    }
  }
  return {
    ...conversation,
    messages: nextNodes,
    ...(nextStamps ? { nodeStamps: nextStamps } : {}),
  };
}

/**
 * 应用 text_delta 增量帧(专题2 H-b)。
 * 返回 "resync" = 本地状态与服务端分叉(节点/message/part 缺失、类型不符、baseLen
 * 校验失败),调用方应重订阅拿全量快照——增量路径永远不猜,失配即重同步。
 * baseLen 容忍规则:服务端帧描述"长度 baseLen 的前缀 + text"。本地字段长度落在
 * [baseLen, baseLen + text.length] 之间(连接首帧快照可能已包含部分增量)→ 只追加
 * 缺口,天然幂等;越界即分叉。
 */
export function applyTextDelta(
  conversation: ConversationDto,
  event: ConversationTextDeltaEventDto,
): ConversationDto | "resync" {
  if (conversation.id !== event.conversationId) {
    return conversation;
  }

  const nodeIndex = conversation.messages.findIndex((node) => node.id === event.nodeId);
  if (nodeIndex < 0) return "resync";
  const node = conversation.messages[nodeIndex]!;
  const messageIndex = node.messages.findIndex((msg) => msg.id === event.messageId);
  if (messageIndex < 0) return "resync";
  const message = node.messages[messageIndex]!;

  const parts = [...message.parts];
  let changed = false;
  for (const delta of event.deltas) {
    const part = parts[delta.partIndex];
    if (!part || typeof part !== "object") return "resync";
    // tool part 增量(M2-2):载体是 output 唯一 text 条目的文本(bash 流式输出)。
    const toolEntry =
      part.type === "tool" && Array.isArray(part.output) && part.output.length === 1
        && part.output[0] && typeof part.output[0] === "object" && !Array.isArray(part.output[0])
        && (part.output[0] as { type?: unknown }).type === "text"
        && typeof (part.output[0] as { text?: unknown }).text === "string"
        ? (part.output[0] as { type: "text"; text: string })
        : null;
    let current: string;
    if (part.type === "text" && typeof part.text === "string") {
      current = part.text;
    } else if (part.type === "reasoning" && typeof part.reasoning === "string") {
      current = part.reasoning;
    } else if (toolEntry) {
      current = toolEntry.text;
    } else {
      return "resync";
    }
    if (current.length < delta.baseLen || current.length > delta.baseLen + delta.text.length) {
      return "resync";
    }
    const suffix = delta.text.slice(current.length - delta.baseLen);
    if (!suffix) continue;
    parts[delta.partIndex] =
      part.type === "text"
        ? { ...part, text: current + suffix }
        : part.type === "reasoning"
          ? { ...part, reasoning: current + suffix }
          : ({ ...part, output: [{ ...toolEntry!, text: current + suffix }] } as MessagePart);
    changed = true;
  }
  if (!changed && conversation.updateAt === event.updateAt && conversation.isGenerating === event.isGenerating) {
    return conversation;
  }

  const nextMessages = [...node.messages];
  nextMessages[messageIndex] = { ...message, parts };
  const nextNodes = [...conversation.messages];
  nextNodes[nodeIndex] = { ...node, messages: nextMessages };
  return {
    ...conversation,
    messages: nextNodes,
    updateAt: event.updateAt,
    isGenerating: event.isGenerating,
  };
}
