// applyNodeUpdate 行为契约(FE-P1-3):这是流式渲染的核心数据通路,
// SSE node_update 帧如何并进当前会话快照的全部语义都钉在这里。
import { describe, expect, test } from "bun:test";

import type { ConversationDto, ConversationNodesPageDto, ConversationNodeUpdateEventDto, ConversationTextDeltaEventDto, MessageNodeDto } from "~/types";
import { applyNodeUpdate, applyTextDelta, mergeConversationSnapshot, prependOlderNodes, replaceNodesRange } from "~/lib/conversation-sync";

function node(id: string, text: string): MessageNodeDto {
  return {
    id,
    selectIndex: 0,
    messages: [
      {
        id: `${id}-m`,
        role: "ASSISTANT",
        parts: [{ type: "text", text }],
        annotations: [],
        createdAt: "2026-07-24T00:00:00",
        finishedAt: null,
        modelId: null,
        usage: null,
        translation: null,
      },
    ],
  };
}

function conversation(nodes: MessageNodeDto[]): ConversationDto {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "标题",
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
    isGenerating: false,
  };
}

function event(overrides: Partial<ConversationNodeUpdateEventDto>): ConversationNodeUpdateEventDto {
  return {
    type: "node_update",
    seq: 100,
    conversationId: "c1",
    nodeId: "n1",
    nodeIndex: 0,
    node: node("n1", "更新后"),
    stamp: "s-new",
    updateAt: 200,
    isGenerating: true,
    serverTime: 300,
    ...overrides,
  };
}

describe("applyNodeUpdate", () => {
  test("非本会话事件原样返回(同引用,不误伤当前打开的会话)", () => {
    const conv = conversation([node("n1", "旧")]);
    expect(applyNodeUpdate(conv, event({ conversationId: "other" }))).toBe(conv);
  });

  test("按 nodeId 命中替换,并采用事件的 updateAt/isGenerating", () => {
    const conv = conversation([node("n1", "旧"), node("n2", "保持")]);
    const next = applyNodeUpdate(conv, event({}));
    expect(next).not.toBe(conv);
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "更新后" }]);
    expect(next.messages[1]).toBe(conv.messages[1]!);
    expect(next.updateAt).toBe(200);
    expect(next.isGenerating).toBe(true);
    // 原快照不被修改(React state 不可变契约)
    expect(conv.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "旧" }]);
  });

  test("nodeId 命中优先于 nodeIndex(服务端 index 与本地错位时以 id 为准)", () => {
    const conv = conversation([node("n1", "一"), node("n2", "二")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n2", nodeIndex: 0, node: node("n2", "新二") }));
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "一" }]);
    expect(next.messages[1]!.messages[0]!.parts).toEqual([{ type: "text", text: "新二" }]);
  });

  test("nodeId 未命中时回退 nodeIndex 替换", () => {
    const conv = conversation([node("n1", "一"), node("n2", "二")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n9", nodeIndex: 1, node: node("n9", "顶掉二") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n9");
  });

  test("nodeIndex 等于当前长度时追加(生成新回复的首帧)", () => {
    const conv = conversation([node("n1", "一")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n2", nodeIndex: 1, node: node("n2", "新节点") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n2");
  });

  test("nodeIndex 越过当前长度也追加(帧乱序到达不丢内容)", () => {
    const conv = conversation([node("n1", "一")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n3", nodeIndex: 5, node: node("n3", "跳跃") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n3");
  });

  test("nodeId 未命中且 nodeIndex 为负时原样返回(防御异常帧)", () => {
    const conv = conversation([node("n1", "一")]);
    expect(applyNodeUpdate(conv, event({ nodeId: "n9", nodeIndex: -1 }))).toBe(conv);
  });
});

function deltaEvent(overrides: Partial<ConversationTextDeltaEventDto>): ConversationTextDeltaEventDto {
  return {
    type: "text_delta",
    seq: 100,
    conversationId: "c1",
    nodeId: "n1",
    messageId: "n1-m",
    deltas: [{ partIndex: 0, baseLen: 1, text: "增量" }],
    updateAt: 200,
    isGenerating: true,
    serverTime: 300,
    ...overrides,
  };
}

describe("applyTextDelta(专题2 H-b)", () => {
  test("非本会话事件原样返回(同引用)", () => {
    const conv = conversation([node("n1", "旧")]);
    expect(applyTextDelta(conv, deltaEvent({ conversationId: "other" }))).toBe(conv);
  });

  test("文本追加:目标 part 更新,未触及节点保持引用身份", () => {
    const conv = conversation([node("n1", "你"), node("n2", "保持")]);
    const next = applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 1, text: "好世界" }] }));
    if (next === "resync") throw new Error("unexpected resync");
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "你好世界" }]);
    expect(next.messages[1]).toBe(conv.messages[1]!);
    expect(next.updateAt).toBe(200);
    expect(next.isGenerating).toBe(true);
    expect(conv.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "你" }]);
  });

  test("reasoning part 追加到 reasoning 字段", () => {
    const base = node("n1", "x");
    base.messages[0]!.parts = [{ type: "reasoning", reasoning: "想" }];
    const conv = conversation([base]);
    const next = applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 1, text: "了想" }] }));
    if (next === "resync") throw new Error("unexpected resync");
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "reasoning", reasoning: "想了想" }]);
  });

  test("tool part 单 text 输出追加(M2-2 bash 流式)", () => {
    const base = node("n1", "x");
    base.messages[0]!.parts = [{
      type: "tool", toolCallId: "c1", toolName: "bash", input: {},
      output: [{ type: "text", text: "first\n" }], approvalState: { type: "auto" },
    }];
    const conv = conversation([base]);
    const next = applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 6, text: "second\n" }] }));
    if (next === "resync") throw new Error("unexpected resync");
    const part = next.messages[0]!.messages[0]!.parts[0] as { output: [{ text: string }] };
    expect(part.output[0].text).toBe("first\nsecond\n");
  });

  test("tool part 多条目 output → resync(非可增量形状)", () => {
    const base = node("n1", "x");
    base.messages[0]!.parts = [{
      type: "tool", toolCallId: "c1", toolName: "bash", input: {},
      output: [{ type: "text", text: "a" }, { type: "text", text: "b" }], approvalState: { type: "auto" },
    }];
    const conv = conversation([base]);
    expect(applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 1, text: "x" }] }))).toBe("resync");
  });

  test("快照重叠容忍:本地已含部分增量时只追加缺口(幂等)", () => {
    const conv = conversation([node("n1", "你好")]);
    const evt = deltaEvent({ deltas: [{ partIndex: 0, baseLen: 1, text: "好世界" }] });
    const next = applyTextDelta(conv, evt);
    if (next === "resync") throw new Error("unexpected resync");
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "你好世界" }]);
    const replay = applyTextDelta(next, evt);
    if (replay === "resync") throw new Error("unexpected resync");
    expect(replay.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "你好世界" }]);
  });

  test("本地比 baseLen 短(丢帧空洞)→ resync", () => {
    const conv = conversation([node("n1", "")]);
    expect(applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 5, text: "尾" }] }))).toBe("resync");
  });

  test("本地比 baseLen+text 还长(已分叉)→ resync", () => {
    const conv = conversation([node("n1", "本地内容非常长")]);
    expect(applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 0, text: "短" }] }))).toBe("resync");
  });

  test("节点/message/part 定位失败 → resync", () => {
    const conv = conversation([node("n1", "x")]);
    expect(applyTextDelta(conv, deltaEvent({ nodeId: "n9" }))).toBe("resync");
    expect(applyTextDelta(conv, deltaEvent({ messageId: "m9" }))).toBe("resync");
    expect(applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 3, baseLen: 0, text: "x" }] }))).toBe("resync");
  });

  test("目标 part 不是 text/reasoning → resync", () => {
    const base = node("n1", "x");
    base.messages[0]!.parts = [{ type: "image", url: "u" } as never];
    const conv = conversation([base]);
    expect(applyTextDelta(conv, deltaEvent({ deltas: [{ partIndex: 0, baseLen: 0, text: "x" }] }))).toBe("resync");
  });
});

// ===== I-2(专题2)窗口化 =====

/** 窗口化会话:messages 为 [offset, offset+nodes.length) 的已加载后缀,stamps 覆盖全部节点。 */
function windowed(
  nodes: MessageNodeDto[],
  offset: number,
  stamps: string[],
  overrides: Partial<ConversationDto> = {},
): ConversationDto {
  return { ...conversation(nodes), nodesOffset: offset, nodeStamps: stamps, ...overrides };
}

describe("applyNodeUpdate(窗口化,I-2)", () => {
  test("nodeId 命中时同步更新清单对应绝对位置的内容戳", () => {
    const conv = windowed([node("n2", "二"), node("n3", "三")], 2, ["a", "b", "c", "d"]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n3", nodeIndex: 3, stamp: "d2", node: node("n3", "新三") }));
    expect(next.nodeStamps).toEqual(["a", "b", "c", "d2"]);
    expect(next.messages[1]!.messages[0]!.parts).toEqual([{ type: "text", text: "新三" }]);
  });

  test("窗口下方的未加载节点:不落地节点本体,只换清单戳并推进元数据", () => {
    const conv = windowed([node("n2", "二"), node("n3", "三")], 2, ["a", "b", "c", "d"]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n0", nodeIndex: 0, stamp: "a2", node: node("n0", "翻译后") }));
    expect(next.messages).toBe(conv.messages); // 节点数组引用不变
    expect(next.nodeStamps).toEqual(["a2", "b", "c", "d"]);
    expect(next.updateAt).toBe(200);
    expect(next.isGenerating).toBe(true);
  });

  test("nodeIndex 是绝对下标:按 offset 换算后替换/追加", () => {
    const conv = windowed([node("n2", "二"), node("n3", "三")], 2, ["a", "b", "c", "d"]);
    const replaced = applyNodeUpdate(conv, event({ nodeId: "n9", nodeIndex: 2, stamp: "c2", node: node("n9", "顶掉二") }));
    expect(replaced.messages[0]!.id).toBe("n9");
    expect(replaced.nodeStamps).toEqual(["a", "b", "c2", "d"]);
    const appended = applyNodeUpdate(conv, event({ nodeId: "n4", nodeIndex: 4, stamp: "e", node: node("n4", "新回复") }));
    expect(appended.messages.map((n) => n.id)).toEqual(["n2", "n3", "n4"]);
    expect(appended.nodeStamps).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("mergeConversationSnapshot(I-2 + bug1 前缀保留)", () => {
  test("全量快照(offset 0/缺省)原样采用", () => {
    const existing = conversation([node("n1", "旧")]);
    const incoming = conversation([node("n1", "新")]);
    expect(mergeConversationSnapshot(existing, incoming).detail).toBe(incoming);
    const full = { ...incoming, nodesOffset: 0, nodeStamps: ["a"] };
    expect(mergeConversationSnapshot(existing, full).detail).toBe(full);
  });

  test("清单一致的已加载前缀被保留(对象身份不变),offset 不抬升", () => {
    const existing = windowed(
      [node("n1", "一"), node("n2", "二"), node("n3", "三"), node("n4", "四")],
      1,
      ["s0", "s1", "s2", "s3", "s4"],
    );
    const incoming = windowed([node("n3", "三新"), node("n4", "四新")], 3, ["s0", "s1", "s2", "s3", "s4"]);
    const { detail: merged, staleRange } = mergeConversationSnapshot(existing, incoming);
    expect(staleRange).toBeNull();
    expect(merged.nodesOffset).toBe(1);
    expect(merged.messages.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4"]);
    // 保留的前缀保持对象身份;窗口内以新快照为准
    expect(merged.messages[0]).toBe(existing.messages[0]!);
    expect(merged.messages[1]).toBe(existing.messages[1]!);
    expect(merged.messages[2]).toBe(incoming.messages[0]!);
    expect(merged.nodeStamps).toBe(incoming.nodeStamps);
  });

  test("戳失配段不再原地丢弃:旧内容保留渲染,清单维持本地旧戳,区间报给调用方修复", () => {
    const existing = windowed(
      [node("n0", "零"), node("n1", "一"), node("n2", "二"), node("n3", "三")],
      0,
      ["s0", "s1-旧", "s2", "s3"],
    );
    const incoming = windowed([node("n3", "三新")], 3, ["s0", "s1-新", "s2", "s3"]);
    const { detail: merged, staleRange } = mergeConversationSnapshot(existing, incoming);
    // n2 一致;n1 戳不同 → [0,2) 陈旧但保留,offset 不变(Virtuoso 不遭遇 firstItemIndex 增大)
    expect(merged.nodesOffset).toBe(0);
    expect(merged.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3"]);
    expect(merged.messages[3]).toBe(incoming.messages[0]!);
    // 陈旧段清单保留本地旧戳(反映本地真实版本,修复前的后续合并仍能识别陈旧)
    expect(merged.nodeStamps).toEqual(["s0", "s1-旧", "s2", "s3"]);
    expect(staleRange).toEqual({ from: 0, to: 2 });
  });

  test("结构漂移(节点删除导致整体错位)时全部前缀标脏保留", () => {
    const existing = windowed(
      [node("n0", "零"), node("n1", "一"), node("n2", "二")],
      0,
      ["s0", "s1", "s2"],
    );
    // 服务端删除了一个节点:清单错位,所有位置的戳都对不上
    const incoming = windowed([node("n2", "二")], 1, ["s0-x", "s2-x"]);
    const { detail: merged, staleRange } = mergeConversationSnapshot(existing, incoming);
    expect(merged.nodesOffset).toBe(0);
    expect(merged.messages.map((n) => n.id)).toEqual(["n0", "n2"]);
    expect(merged.nodeStamps).toEqual(["s0", "s2-x"]);
    expect(staleRange).toEqual({ from: 0, to: 1 });
  });

  test("本地已加载段接不上新窗口起点(中间有空洞)时原样采用新快照", () => {
    const existing = windowed([node("n0", "零"), node("n1", "一")], 0, ["s0", "s1"]);
    // 离开期间追加了很多节点,新窗口从 abs 5 开始,本地 [0,2) 与之有空洞
    const incoming = windowed([node("n5", "五")], 5, ["s0", "s1", "s2", "s3", "s4", "s5"]);
    const result = mergeConversationSnapshot(existing, incoming);
    expect(result.detail).toBe(incoming);
    expect(result.staleRange).toBeNull();
  });

  test("本地无清单(极老缓存形状)时原样采用新快照", () => {
    const existing = conversation([node("n1", "一"), node("n2", "二")]);
    const incoming = windowed([node("n2", "二")], 1, ["s0", "s1"]);
    expect(mergeConversationSnapshot(existing, incoming).detail).toBe(incoming);
  });
});

describe("replaceNodesRange(bug1 陈旧前缀修复)", () => {
  function page(nodes: MessageNodeDto[], offset: number, stamps: string[]): ConversationNodesPageDto {
    return { nodes, stamps, offset, updateAt: 500 };
  }

  test("对齐分片原地替换节点与清单戳,长度与 offset 不变", () => {
    const conv = windowed(
      [node("n0", "旧零"), node("n1", "旧一"), node("n2", "二")],
      1,
      ["s0", "s1-旧", "s2-旧", "s3"],
    );
    const next = replaceNodesRange(conv, page([node("n0", "新零"), node("n1", "新一")], 1, ["s1-新", "s2-新"]));
    expect(next).not.toBe("stale");
    if (next === "stale") return;
    expect(next.nodesOffset).toBe(1);
    expect(next.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "新零" }]);
    expect(next.messages[2]).toBe(conv.messages[2]!); // 区间外节点身份不变
    expect(next.nodeStamps).toEqual(["s0", "s1-新", "s2-新", "s3"]);
  });

  test("分片越过已加载窗口边界或为空时拒绝(stale)", () => {
    const conv = windowed([node("n1", "一"), node("n2", "二")], 1, ["s0", "s1", "s2"]);
    expect(replaceNodesRange(conv, page([node("n0", "零"), node("n1", "一")], 0, ["s0", "s1"]))).toBe("stale");
    expect(replaceNodesRange(conv, page([node("n2", "二"), node("n3", "三")], 2, ["s2", "s3"]))).toBe("stale");
    expect(replaceNodesRange(conv, page([], 1, []))).toBe("stale");
  });
});

describe("prependOlderNodes(I-2)", () => {
  function page(nodes: MessageNodeDto[], offset: number, stamps: string[]): ConversationNodesPageDto {
    return { nodes, stamps, offset, updateAt: 500 };
  }

  test("紧邻前缀拼接:offset 前移、清单区间被分片的戳覆盖", () => {
    const conv = windowed([node("n2", "二"), node("n3", "三")], 2, ["a", "b", "c", "d"]);
    const next = prependOlderNodes(conv, page([node("n0", "零"), node("n1", "一")], 0, ["a2", "b2"]));
    expect(next).not.toBe("stale");
    if (next === "stale") return;
    expect(next.nodesOffset).toBe(0);
    expect(next.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3"]);
    expect(next.nodeStamps).toEqual(["a2", "b2", "c", "d"]);
    // 已加载节点身份不变
    expect(next.messages[2]).toBe(conv.messages[0]!);
  });

  test("与当前窗口不紧邻(拼接期间状态被推进)返回 stale", () => {
    const conv = windowed([node("n2", "二")], 2, ["a", "b", "c"]);
    expect(prependOlderNodes(conv, page([node("n0", "零")], 0, ["a2"]))).toBe("stale");
  });

  test("已到头(offset 0)返回 stale(调用方不应触发)", () => {
    const conv = conversation([node("n0", "零")]);
    expect(prependOlderNodes(conv, page([node("nx", "x")], 0, ["s"]))).toBe("stale");
  });
});
