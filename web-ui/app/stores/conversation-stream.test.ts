// conversation-stream 行为契约(专题1 D 族):引用计数生命周期 + 元数据桥闸门。
// 通过测试注入缝驱动脚本化传输,不 mock 全局模块(防污染同进程其它测试文件)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApiError, type sse } from "~/services/api";
import type { ConversationDto, MessageNodeDto } from "~/types";
import {
  resetConversationStoreForTest,
  useConversationStore,
} from "./conversation-store";
import {
  acquireConversationStream,
  ensureFullConversationDetail,
  installConversationStreamTestSeam,
  loadOlderConversationNodes,
  onConversationSummaryChange,
  resetConversationStreamForTest,
  setConversationStreamAttention,
  shouldBroadcastConversationSummary,
  type ConversationStreamEvent,
  type ConversationSummaryUpdate,
} from "./conversation-stream";

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

interface FakeStream {
  url: string;
  signal: AbortSignal | undefined;
  emit: (event: string, data: ConversationStreamEvent) => void;
  fail: (error: Error) => void;
}

let streams: FakeStream[] = [];

const fakeTransport = ((url, callbacks, options) => {
  streams.push({
    url,
    signal: options?.signal,
    emit: (event, data) => callbacks.onMessage({ event, data }),
    fail: (error) => callbacks.onError?.(error),
  });
  return new Promise<void>(() => {});
}) as typeof sse;

const entries = () => useConversationStore.getState().entries;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetConversationStoreForTest();
  resetConversationStreamForTest();
  streams = [];
  installConversationStreamTestSeam({ transport: fakeTransport });
});

afterEach(() => {
  resetConversationStreamForTest();
});

describe("shouldBroadcastConversationSummary(元数据桥闸门)", () => {
  const base = conversation("a", { isGenerating: true });

  test("无前值(首个快照)必广播", () => {
    expect(shouldBroadcastConversationSummary(null, base)).toBe(true);
  });

  test("纯内容增量(仅 messages/updateAt 变)不广播 —— 侧边栏 30Hz 重排的根治点", () => {
    const next = { ...base, messages: [node("a-n1", "更长的流式内容")], updateAt: 999 };
    expect(shouldBroadcastConversationSummary(base, next)).toBe(false);
  });

  test("title / isPinned / isGenerating 任一变化即广播", () => {
    expect(shouldBroadcastConversationSummary(base, { ...base, title: "新标题" })).toBe(true);
    expect(shouldBroadcastConversationSummary(base, { ...base, isPinned: true })).toBe(true);
    expect(shouldBroadcastConversationSummary(base, { ...base, isGenerating: false })).toBe(true);
  });
});

describe("快照协商(专题2 I-1)", () => {
  const snapshotFrame = (updateAt: number, token: string) => ({
    type: "snapshot" as const,
    seq: 1,
    conversation: conversation("a", { updateAt }),
    serverTime: Date.now(),
    negotiationToken: token,
  });

  test("首次订阅不带令牌;缓存命中后重开流回传令牌", async () => {
    const release = acquireConversationStream("a");
    expect(streams[0]!.url).toBe("conversations/a/stream");
    streams[0]!.emit("snapshot", snapshotFrame(100, "100:abc"));
    release();
    await wait(80); // 关流,缓存与令牌保留

    acquireConversationStream("a");
    expect(streams).toHaveLength(2);
    expect(streams[1]!.url).toBe("conversations/a/stream?token=100%3Aabc");
  });

  test("snapshot_meta 命中:缓存 detail 原样保留,订阅态结束", async () => {
    const release = acquireConversationStream("a");
    streams[0]!.emit("snapshot", snapshotFrame(100, "100:abc"));
    const cached = entries()["a"]!.detail;
    release();
    await wait(80);

    acquireConversationStream("a");
    expect(entries()["a"]!.subscribing).toBe(true);
    streams[1]!.emit("snapshot_meta", {
      type: "snapshot_meta",
      seq: 2,
      conversationId: "a",
      updateAt: 100,
      isGenerating: false,
      negotiationToken: "100:abc",
      serverTime: Date.now(),
    });
    expect(entries()["a"]!.subscribing).toBe(false);
    expect(entries()["a"]!.detail).toBe(cached!); // 未整树替换
  });

  test("增量帧推进 updateAt 后令牌作废(不再回传陈旧令牌)", async () => {
    const release = acquireConversationStream("a");
    setConversationStreamAttention("a"); // 贴底观看:增量逐帧落地
    streams[0]!.emit("snapshot", snapshotFrame(100, "100:abc"));
    streams[0]!.emit("text_delta", {
      type: "text_delta",
      seq: 2,
      conversationId: "a",
      nodeId: "a-n1",
      messageId: "a-n1-m",
      deltas: [{ partIndex: 0, baseLen: 2, text: "增长" }],
      updateAt: 150,
      isGenerating: true,
      serverTime: Date.now(),
    });
    release();
    await wait(80);

    acquireConversationStream("a");
    expect(streams[1]!.url).toBe("conversations/a/stream"); // 无 ?token=
  });

  test("resync 重启不带令牌(分叉后必须拿全量)", async () => {
    acquireConversationStream("a");
    setConversationStreamAttention("a");
    streams[0]!.emit("snapshot", snapshotFrame(100, "100:abc"));
    streams[0]!.emit("text_delta", {
      type: "text_delta",
      seq: 2,
      conversationId: "a",
      nodeId: "a-n1",
      messageId: "a-n1-m",
      deltas: [{ partIndex: 0, baseLen: 99, text: "空洞" }],
      updateAt: 150,
      isGenerating: true,
      serverTime: Date.now(),
    });
    await wait(10);
    expect(streams).toHaveLength(2);
    expect(streams[1]!.url).toBe("conversations/a/stream");
  });
});

describe("引用计数生命周期", () => {
  test("同会话两次 acquire 共享一条流;全部 release 后延迟关断", async () => {
    const release1 = acquireConversationStream("a");
    const release2 = acquireConversationStream("a");
    expect(streams).toHaveLength(1);
    expect(streams[0]!.url).toBe("conversations/a/stream");

    release1();
    await wait(80);
    expect(streams[0]!.signal?.aborted).toBe(false);

    release2();
    await wait(80);
    expect(streams[0]!.signal?.aborted).toBe(true);
  });

  test("StrictMode 双挂载(release 后立即 re-acquire)不断连", async () => {
    const release1 = acquireConversationStream("a");
    release1();
    const release2 = acquireConversationStream("a");
    await wait(80);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.signal?.aborted).toBe(false);
    release2();
    await wait(80);
    expect(streams[0]!.signal?.aborted).toBe(true);
  });

  test("release 幂等:同一句柄重复调用不重复扣减", async () => {
    const release1 = acquireConversationStream("a");
    const release2 = acquireConversationStream("a");
    release1();
    release1();
    await wait(80);
    expect(streams[0]!.signal?.aborted).toBe(false);
    release2();
    await wait(80);
    expect(streams[0]!.signal?.aborted).toBe(true);
  });

  test("关断后 entry 回归 LRU(可被淘汰),订阅期间置 subscribing", async () => {
    const release = acquireConversationStream("a");
    expect(entries()["a"]!.subscribing).toBe(true);
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a"),
      serverTime: Date.now(),
    });
    expect(entries()["a"]!.subscribing).toBe(false);
    release();
    await wait(80);
    // entry 仍作为缓存保留(切回零加载态),只是不再豁免淘汰
    expect(entries()["a"]!.detail).not.toBeNull();
  });
});

describe("流事件语义", () => {
  test("快照落地并广播;纯内容 node_update 不再广播", () => {
    const updates: ConversationSummaryUpdate[] = [];
    const off = onConversationSummaryChange((update) => updates.push(update));
    acquireConversationStream("a");

    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", { isGenerating: true, updateAt: 100 }),
      serverTime: Date.now(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.isGenerating).toBe(true);

    // 流式 chunk:isGenerating 维持 true,仅内容与 updateAt 变 —— 不广播
    streams[0]!.emit("node_update", {
      type: "node_update",
    stamp: "s1",
      seq: 2,
      conversationId: "a",
      nodeId: "a-n1",
      nodeIndex: 0,
      node: node("a-n1", "更新后"),
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    expect(updates).toHaveLength(1);
    expect(entries()["a"]!.detail!.updateAt).toBe(200);

    // 生成结束帧:isGenerating 跳变 —— 广播并携带最新 updateAt
    streams[0]!.emit("node_update", {
      type: "node_update",
    stamp: "s1",
      seq: 3,
      conversationId: "a",
      nodeId: "a-n1",
      nodeIndex: 0,
      node: node("a-n1", "最终"),
      updateAt: 300,
      isGenerating: false,
      serverTime: Date.now(),
    });
    expect(updates).toHaveLength(2);
    expect(updates[1]!.isGenerating).toBe(false);
    expect(updates[1]!.updateAt).toBe(300);
    off();
  });

  test("快照前收到 node_update(no_detail)→ 重启流拿全量", async () => {
    acquireConversationStream("a");
    streams[0]!.emit("node_update", {
      type: "node_update",
    stamp: "s1",
      seq: 1,
      conversationId: "a",
      nodeId: "a-n1",
      nodeIndex: 0,
      node: node("a-n1", "增量先到"),
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    await wait(10); // queueMicrotask 后重启
    expect(streams).toHaveLength(2);
    expect(streams[0]!.signal?.aborted).toBe(true);
    expect(streams[1]!.signal?.aborted).toBe(false);
  });

  test("text_delta 增量落地:文本追加、不广播摘要(专题2 H-b)", () => {
    const updates: ConversationSummaryUpdate[] = [];
    const off = onConversationSummaryChange((update) => updates.push(update));
    acquireConversationStream("a");
    setConversationStreamAttention("a");
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", { isGenerating: true, updateAt: 100 }),
      serverTime: Date.now(),
    });
    expect(updates).toHaveLength(1);

    streams[0]!.emit("text_delta", {
      type: "text_delta",
      seq: 2,
      conversationId: "a",
      nodeId: "a-n1",
      messageId: "a-n1-m",
      deltas: [{ partIndex: 0, baseLen: 2, text: "继续增长" }],
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    const parts = entries()["a"]!.detail!.messages[0]!.messages[0]!.parts;
    expect(parts).toEqual([{ type: "text", text: "内容继续增长" }]);
    expect(entries()["a"]!.detail!.updateAt).toBe(200);
    expect(updates).toHaveLength(1); // 纯内容增量不打到侧边栏
    off();
  });

  test("text_delta 分叉(baseLen 失配)→ 重启流拿全量快照", async () => {
    acquireConversationStream("a");
    setConversationStreamAttention("a");
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", { isGenerating: true }),
      serverTime: Date.now(),
    });
    streams[0]!.emit("text_delta", {
      type: "text_delta",
      seq: 2,
      conversationId: "a",
      nodeId: "a-n1",
      messageId: "a-n1-m",
      deltas: [{ partIndex: 0, baseLen: 99, text: "空洞" }],
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    await wait(10);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.signal?.aborted).toBe(true);
    // 本地内容未被污染(resync 不落地任何增量)
    const parts = entries()["a"]!.detail!.messages[0]!.messages[0]!.parts;
    expect(parts).toEqual([{ type: "text", text: "内容" }]);
  });

  test("快照前收到 text_delta(no_detail)→ 重启流", async () => {
    acquireConversationStream("a");
    setConversationStreamAttention("a");
    streams[0]!.emit("text_delta", {
      type: "text_delta",
      seq: 1,
      conversationId: "a",
      nodeId: "a-n1",
      messageId: "a-n1-m",
      deltas: [{ partIndex: 0, baseLen: 0, text: "x" }],
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    await wait(10);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.signal?.aborted).toBe(true);
  });
  test("404 按'暂无会话'处理(无错误);其余致命 4xx 进错误态", () => {
    acquireConversationStream("a");
    streams[0]!.fail(new ApiError("not found", 404));
    expect(entries()["a"]!.subscribing).toBe(false);
    expect(entries()["a"]!.error).toBeNull();

    acquireConversationStream("b");
    streams[1]!.fail(new ApiError("bad request", 400));
    expect(entries()["b"]!.subscribing).toBe(false);
    expect(entries()["b"]!.error).toBe("bad request");
  });

  test("重启后旧连接的迟到帧被丢弃", async () => {
    acquireConversationStream("a");
    const first = streams[0]!;
    first.emit("node_update", {
      type: "node_update",
    stamp: "s1",
      seq: 1,
      conversationId: "a",
      nodeId: "a-n1",
      nodeIndex: 0,
      node: node("a-n1", "触发重启"),
      updateAt: 200,
      isGenerating: true,
      serverTime: Date.now(),
    });
    await wait(10);
    // 旧连接再吐一帧快照:必须被丢弃(controller 已换代)
    first.emit("snapshot", {
      type: "snapshot",
      seq: 2,
      conversation: conversation("a", { title: "迟到快照" }),
      serverTime: Date.now(),
    });
    expect(entries()["a"]?.detail ?? null).toBeNull();
  });
});

describe("流式增量的注意力节奏(滚离底部/后台会话攒批)", () => {
  const delta = (seq: number, baseLen: number, textDelta: string) => ({
    type: "text_delta" as const,
    seq,
    conversationId: "a",
    nodeId: "a-n1",
    messageId: "a-n1-m",
    deltas: [{ partIndex: 0, baseLen, text: textDelta }],
    updateAt: 100 + seq,
    isGenerating: true,
    serverTime: Date.now(),
  });
  const openWithSnapshot = () => {
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", { isGenerating: true, updateAt: 100 }),
      serverTime: Date.now(),
    });
  };
  const text = () =>
    (entries()["a"]!.detail!.messages[0]!.messages[0]!.parts[0] as { text: string }).text;

  test("无人贴底:增量不逐帧落地,定时器到点按序一次性补齐", async () => {
    openWithSnapshot();
    streams[0]!.emit("text_delta", delta(2, 2, "AA"));
    streams[0]!.emit("text_delta", delta(3, 4, "BB"));
    expect(text()).toBe("内容"); // 攒批中,未落地
    await wait(320);
    expect(text()).toBe("内容AABB");
    expect(streams).toHaveLength(1); // 按序应用,无分叉重启
  });

  test("回到贴底立即补齐攒批;贴底期间恢复逐帧", () => {
    openWithSnapshot();
    streams[0]!.emit("text_delta", delta(2, 2, "AA"));
    expect(text()).toBe("内容");
    setConversationStreamAttention("a");
    expect(text()).toBe("内容AA"); // 上报注意力即补齐
    streams[0]!.emit("text_delta", delta(3, 4, "BB"));
    expect(text()).toBe("内容AABB"); // 逐帧
  });

  test("node_update 落地前先补齐攒批(保序,不误判分叉)", async () => {
    openWithSnapshot();
    streams[0]!.emit("text_delta", delta(2, 2, "AA"));
    streams[0]!.emit("node_update", {
      type: "node_update",
      stamp: "s2",
      seq: 3,
      conversationId: "a",
      nodeId: "a-n1",
      nodeIndex: 0,
      node: node("a-n1", "权威内容"),
      updateAt: 300,
      isGenerating: true,
      serverTime: Date.now(),
    });
    expect(text()).toBe("权威内容");
    await wait(320); // 定时器到点也没有残留攒批可再落
    expect(text()).toBe("权威内容");
    expect(streams).toHaveLength(1);
  });
});

describe("窗口化翻页与全量确保(专题2 I-2)", () => {
  function windowedSnapshot(): ConversationDto {
    return conversation("a", {
      messages: [node("n2", "二")],
      nodesOffset: 2,
      nodeStamps: ["s0", "s1", "s2"],
    });
  }

  test("loadOlderConversationNodes:拉紧邻分片拼接;已到头不再请求", async () => {
    const pageCalls: Array<{ before: number; beforeId: string }> = [];
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationNodesPage: (_id, before, beforeId) => {
        pageCalls.push({ before, beforeId });
        return Promise.resolve({
          nodes: [node("n0", "零"), node("n1", "一")],
          stamps: ["s0", "s1"],
          offset: 0,
          updateAt: 100,
        });
      },
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", { type: "snapshot", seq: 1, conversation: windowedSnapshot(), serverTime: Date.now() } as ConversationStreamEvent);

    await loadOlderConversationNodes("a");
    expect(pageCalls).toEqual([{ before: 2, beforeId: "n2" }]);
    const detail = entries()["a"]!.detail!;
    expect(detail.nodesOffset).toBe(0);
    expect(detail.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);

    await loadOlderConversationNodes("a");
    expect(pageCalls).toHaveLength(1); // offset=0 到头,不再请求
  });

  test("分片 409(快照后结构漂移)→ 重开流拿新快照自愈", async () => {
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationNodesPage: () => Promise.reject(new ApiError("Node window out of sync", 409)),
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", { type: "snapshot", seq: 1, conversation: windowedSnapshot(), serverTime: Date.now() } as ConversationStreamEvent);
    expect(streams).toHaveLength(1);
    await loadOlderConversationNodes("a");
    expect(streams).toHaveLength(2); // 重开(旧连接中止,新连接建立)
    expect(streams[0]!.signal?.aborted).toBe(true);
  });

  test("ensureFullConversationDetail:窗口化经 REST 展开为全量;已全量零请求直返", async () => {
    let fullCalls = 0;
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationSnapshot: () => {
        fullCalls += 1;
        return Promise.resolve(
          conversation("a", {
            messages: [node("n0", "零"), node("n1", "一"), node("n2", "二")],
            nodesOffset: 0,
            nodeStamps: ["s0", "s1", "s2"],
          }),
        );
      },
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", { type: "snapshot", seq: 1, conversation: windowedSnapshot(), serverTime: Date.now() } as ConversationStreamEvent);

    const full = await ensureFullConversationDetail("a");
    expect(fullCalls).toBe(1);
    expect(full?.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
    expect(full?.nodesOffset).toBe(0);

    const again = await ensureFullConversationDetail("a");
    expect(fullCalls).toBe(1); // 已全量:直接返回缓存
    expect(again).toBe(entries()["a"]!.detail!);
  });

  test("ensureFullConversationDetail:拉取失败返回 null(调用方必须放弃截断数据)", async () => {
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationSnapshot: () => Promise.reject(new ApiError("boom", 500)),
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", { type: "snapshot", seq: 1, conversation: windowedSnapshot(), serverTime: Date.now() } as ConversationStreamEvent);
    expect(await ensureFullConversationDetail("a")).toBeNull();
  });

  // A2 回归(复查):生成期间 SSE 每帧推进本地 updateAt,全量 REST 快照必被 R7-3
  // 单调守卫判陈旧拒收——旧实现导出/分享在生成中稳定失败。历史前缀不随生成变化,
  // 守卫拒收后应从全量快照切前缀按分片语义拼接,保留(更新的)本地窗口。
  test("ensureFullConversationDetail:本地比全量快照新(生成中)→ 拼前缀成功,本地窗口保留", async () => {
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationSnapshot: () =>
        Promise.resolve(
          conversation("a", {
            messages: [node("n0", "零"), node("n1", "一"), node("n2", "二(陈旧)")],
            nodesOffset: 0,
            nodeStamps: ["s0", "s1", "s2-old"],
            updateAt: 100, // 早于本地 200 → 单调守卫拒收整体
          }),
        ),
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", {
        messages: [node("n2", "二(生成中,较新)")],
        nodesOffset: 2,
        nodeStamps: ["s0", "s1", "s2"],
        updateAt: 200,
      }),
      serverTime: Date.now(),
    } as ConversationStreamEvent);

    const full = await ensureFullConversationDetail("a");
    expect(full).not.toBeNull();
    expect(full!.nodesOffset).toBe(0);
    expect(full!.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
    // 本地窗口(更新的生成中内容)保留,不被陈旧全量覆盖
    expect(full!.messages[2]!.messages[0]!.parts).toEqual([{ type: "text", text: "二(生成中,较新)" }]);
    expect(full!.updateAt).toBe(200);
  });

  test("ensureFullConversationDetail:缝合点 id 对不上(窗口结构漂移)→ 返回 null 不硬拼", async () => {
    installConversationStreamTestSeam({
      transport: fakeTransport,
      fetchConversationSnapshot: () =>
        Promise.resolve(
          conversation("a", {
            messages: [node("n0", "零"), node("n1", "一"), node("nX", "结构已变")],
            nodesOffset: 0,
            nodeStamps: ["s0", "s1", "sX"],
            updateAt: 100,
          }),
        ),
    });
    acquireConversationStream("a");
    streams[0]!.emit("snapshot", {
      type: "snapshot",
      seq: 1,
      conversation: conversation("a", {
        messages: [node("n2", "二")],
        nodesOffset: 2,
        nodeStamps: ["s0", "s1", "s2"],
        updateAt: 200,
      }),
      serverTime: Date.now(),
    } as ConversationStreamEvent);

    expect(await ensureFullConversationDetail("a")).toBeNull();
  });
});
