// conversation-store 行为契约(专题1 D 族):entries 即缓存 + 细粒度写入。
// 钉住四条根基语义:引用隔离(改 A 不动 B)、LRU 淘汰与 retain 豁免、
// node_update 无快照时返回 no_detail、轮询快照的 updateAt 单调守卫(R7-3)。
import { beforeEach, describe, expect, test } from "bun:test";

import type { ConversationDto, ConversationNodeUpdateEventDto, MessageNodeDto } from "~/types";
import {
  applyConversationNodesPage,
  applyConversationNodeUpdate,
  applyConversationSnapshot,
  applyPolledConversationSnapshot,
  evictConversations,
  releaseConversationEntry,
  resetConversationStoreForTest,
  retainConversationEntry,
  setConversationError,
  setConversationSubscribing,
  useConversationStore,
} from "~/stores/conversation-store";

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

function conversation(id: string, overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id,
    assistantId: "a1",
    systemPrompt: null,
    title: `标题-${id}`,
    messages: [node(`${id}-n1`, "内容")],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 100,
    isGenerating: false,
    ...overrides,
  };
}

function nodeUpdate(
  conversationId: string,
  overrides: Partial<ConversationNodeUpdateEventDto> = {},
): ConversationNodeUpdateEventDto {
  return {
    type: "node_update",
    stamp: "s1",
    seq: 1,
    conversationId,
    nodeId: `${conversationId}-n1`,
    nodeIndex: 0,
    node: node(`${conversationId}-n1`, "更新后"),
    updateAt: 200,
    isGenerating: true,
    serverTime: 300,
    ...overrides,
  };
}

const entries = () => useConversationStore.getState().entries;

beforeEach(() => {
  resetConversationStoreForTest();
});

describe("引用隔离(细粒度订阅的根基)", () => {
  test("写入 A 会话不改变 B 会话的 entry 引用", () => {
    applyConversationSnapshot(conversation("a"));
    applyConversationSnapshot(conversation("b"));
    const entryB = entries()["b"];
    applyConversationNodeUpdate(nodeUpdate("a"));
    expect(entries()["b"]).toBe(entryB!);
    expect(entries()["a"]!.detail!.updateAt).toBe(200);
  });

  test("流式增量期间标量字段值稳定(窄选择器零重渲染的前提)", () => {
    applyConversationSnapshot(conversation("a", { chatSuggestions: ["s1"] }));
    const before = entries()["a"]!.detail!;
    applyConversationNodeUpdate(nodeUpdate("a"));
    const after = entries()["a"]!.detail!;
    expect(after.assistantId).toBe(before.assistantId);
    expect(after.title).toBe(before.title);
    expect(after.systemPrompt).toBe(before.systemPrompt);
    // applyNodeUpdate 展开时 chatSuggestions 引用原样带过
    expect(after.chatSuggestions).toBe(before.chatSuggestions);
  });
});

describe("node_update 落地", () => {
  test("无快照时返回 no_detail 且不产生 entry(调用方应重启流)", () => {
    expect(applyConversationNodeUpdate(nodeUpdate("ghost"))).toBe("no_detail");
    expect(entries()["ghost"]).toBeUndefined();
  });

  test("命中时应用增量并清 subscribing/error", () => {
    applyConversationSnapshot(conversation("a"));
    setConversationSubscribing("a", true);
    setConversationError("a", "临时错误");
    expect(applyConversationNodeUpdate(nodeUpdate("a"))).toBe("applied");
    const entry = entries()["a"]!;
    expect(entry.subscribing).toBe(false);
    expect(entry.error).toBeNull();
    expect(entry.detail!.isGenerating).toBe(true);
  });
});

describe("轮询快照单调守卫(R7-3)", () => {
  test("updateAt 更旧的轮询响应被拒绝(SSE 已推进,防流式文本闪跳)", () => {
    applyConversationSnapshot(conversation("a", { updateAt: 500 }));
    const before = entries()["a"];
    expect(applyPolledConversationSnapshot(conversation("a", { updateAt: 400 }))).toBe(false);
    expect(entries()["a"]).toBe(before!);
  });

  test("updateAt 相等或更新则接受(合法的改短编辑不误判)", () => {
    applyConversationSnapshot(conversation("a", { updateAt: 500 }));
    expect(applyPolledConversationSnapshot(conversation("a", { updateAt: 500 }))).toBe(true);
    expect(applyPolledConversationSnapshot(conversation("a", { updateAt: 600 }))).toBe(true);
    expect(entries()["a"]!.detail!.updateAt).toBe(600);
  });

  test("无 entry 时也接受(轮询先于快照到达的冷路径)", () => {
    expect(applyPolledConversationSnapshot(conversation("a"))).toBe(true);
    expect(entries()["a"]!.detail).not.toBeNull();
  });
});

describe("LRU 淘汰与 retain 豁免", () => {
  test("无人 retain 的 entry 超过 20 个时淘汰最久未用", () => {
    for (let i = 0; i < 21; i += 1) applyConversationSnapshot(conversation(`c${i}`));
    expect(Object.keys(entries())).toHaveLength(20);
    expect(entries()["c0"]).toBeUndefined();
    expect(entries()["c20"]).toBeDefined();
  });

  test("写入即提位:最早写入但最近更新的 entry 不被淘汰", () => {
    for (let i = 0; i < 20; i += 1) applyConversationSnapshot(conversation(`c${i}`));
    applyConversationNodeUpdate(nodeUpdate("c0"));
    applyConversationSnapshot(conversation("c20"));
    expect(entries()["c0"]).toBeDefined();
    expect(entries()["c1"]).toBeUndefined();
  });

  test("被 retain 的 entry 不参与淘汰;release 后回归 LRU 并立即结算", () => {
    retainConversationEntry("pinned");
    applyConversationSnapshot(conversation("pinned"));
    for (let i = 0; i < 21; i += 1) applyConversationSnapshot(conversation(`c${i}`));
    expect(entries()["pinned"]).toBeDefined();
    // pinned 之外恰好 20 个:c0 已被淘汰
    expect(entries()["c0"]).toBeUndefined();
    releaseConversationEntry("pinned");
    // release 后 pinned 是最旧的非豁免 entry,超限即淘汰
    expect(entries()["pinned"]).toBeUndefined();
  });

  test("重复 retain 计数正确:全部 release 前不淘汰", () => {
    retainConversationEntry("p");
    retainConversationEntry("p");
    applyConversationSnapshot(conversation("p"));
    releaseConversationEntry("p");
    for (let i = 0; i < 21; i += 1) applyConversationSnapshot(conversation(`c${i}`));
    expect(entries()["p"]).toBeDefined();
    releaseConversationEntry("p");
    expect(entries()["p"]).toBeUndefined();
  });
});

describe("evict(删除会话/清库)", () => {
  test("驱逐指定 id;不存在的 id 不触发状态变更", () => {
    applyConversationSnapshot(conversation("a"));
    applyConversationSnapshot(conversation("b"));
    const before = entries();
    evictConversations(["ghost"]);
    expect(entries()).toBe(before);
    evictConversations(["a"]);
    expect(entries()["a"]).toBeUndefined();
    expect(entries()["b"]).toBeDefined();
  });

  test("被 retain 的 entry 也可被显式驱逐(删除当前打开的会话)", () => {
    retainConversationEntry("a");
    applyConversationSnapshot(conversation("a"));
    evictConversations(["a"]);
    expect(entries()["a"]).toBeUndefined();
    // 驱逐后快照再来(流尚未关断的竞态帧)可重建,release 后正常淘汰
    applyConversationSnapshot(conversation("a"));
    releaseConversationEntry("a");
    expect(entries()["a"]).toBeDefined();
  });
});

describe("subscribing / error 标志", () => {
  test("值未变时不产生新状态(防无效重渲染)", () => {
    applyConversationSnapshot(conversation("a"));
    const before = entries();
    setConversationSubscribing("a", false);
    setConversationError("a", null);
    expect(entries()).toBe(before);
  });

  test("对无 entry 的 id 设标志会创建骨架 entry(订阅先于快照)", () => {
    setConversationSubscribing("a", true);
    expect(entries()["a"]).toEqual({ detail: null, subscribing: true, error: null });
  });
});

describe("窗口化快照与翻页分片(专题2 I-2)", () => {
  test("窗口化快照与本地已加载前缀做可验证合并", () => {
    applyConversationSnapshot(
      conversation("c1", {
        messages: [node("n0", "零"), node("n1", "一"), node("n2", "二")],
        nodesOffset: 0,
        nodeStamps: ["s0", "s1", "s2"],
      }),
    );
    const kept = entries()["c1"]!.detail!.messages[0];
    applyConversationSnapshot(
      conversation("c1", {
        messages: [node("n2", "二新"), node("n3", "三")],
        nodesOffset: 2,
        nodeStamps: ["s0", "s1", "s2x", "s3"],
        updateAt: 200,
      }),
    );
    const detail = entries()["c1"]!.detail!;
    expect(detail.nodesOffset).toBe(0);
    expect(detail.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3"]);
    expect(detail.messages[0]).toBe(kept!);
  });

  test("翻页分片:applied / stale / no_detail 三态", () => {
    expect(
      applyConversationNodesPage("c9", { nodes: [node("x", "x")], stamps: ["s"], offset: 0, updateAt: 1 }),
    ).toBe("no_detail");

    applyConversationSnapshot(
      conversation("c1", {
        messages: [node("n2", "二")],
        nodesOffset: 2,
        nodeStamps: ["s0", "s1", "s2"],
      }),
    );
    expect(
      applyConversationNodesPage("c1", {
        nodes: [node("n0", "零"), node("n1", "一")],
        stamps: ["s0", "s1"],
        offset: 0,
        updateAt: 1,
      }),
    ).toBe("applied");
    const detail = entries()["c1"]!.detail!;
    expect(detail.nodesOffset).toBe(0);
    expect(detail.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);

    // 已到头再拼 → stale
    expect(
      applyConversationNodesPage("c1", { nodes: [node("nx", "x")], stamps: ["s"], offset: 0, updateAt: 1 }),
    ).toBe("stale");
  });
});
