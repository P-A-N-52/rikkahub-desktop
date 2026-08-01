// 批6复审 G1 回归:OCR fire-and-forget 续体在"长 await 期间会话被删除"时必须丢弃结果。
// persistConversation 是无条件 upsert,不设防会把已删会话连整棵消息树复活("复活删除"),
// 还会给僵尸会话触发 generateAnswer 续写。
// 经真实路由驱动 messages POST,mock 模块边界制造时序:
//   - attachOcrToImageParts → 可控 deferred("删除发生在 OCR 完成前")
//   - persistConversation / deletePcConversations → 记录桩(无 DB)
//   - generateAnswer → 记录桩
// 注意:bun 的 mock.module 全局生效且跨测试文件不回收——本文件用"闸门委托"式桩
// (仅 guardActive 时改写,否则透传真实实现),避免桩泄漏污染后续文件(见下方说明)。
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { Conversation, State } from "../foundation/types";
import { configureWorkingSet, registerConversation, removeConversations } from "../conversations/working-set";
import { generating } from "../conversations/generation-state";
import { setState, state } from "../persistence/json-store";

import * as actualConversations from "../conversations/index";
import * as actualAuxiliary from "../conversations/auxiliary";
import * as actualOrchestrator from "../conversations/orchestrator";

// import * 命名空间是"活绑定":mock.module 替换注册表后 actualConversations.* 会指向桩本身
// (委托即自我递归)。必须在 mock.module 之前把真实函数对象捕获进常量,委托时调它们。
const realPersistConversation = actualConversations.persistConversation;
const realDeletePcConversations = actualConversations.deletePcConversations;
const realMarkOcrPendingParts = actualAuxiliary.markOcrPendingParts;
const realAttachOcrToImageParts = actualAuxiliary.attachOcrToImageParts;
const realGenerateAnswer = actualOrchestrator.generateAnswer;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const persistedIds: string[] = [];
const generatedIds: string[] = [];
let ocrGate = deferred();

// 闸门委托:仅当本文件用例激活(guardActive)时改写行为,否则透传真实实现。bun 的
// mock.module 跨文件泄漏且 afterAll 重挂来不及(其他文件在统一加载期已捕获桩),此式让
// 泄漏出去的桩对后续文件与真实模块等价(M4-0:曾把 persistConversation 打成空桩污染 workspace.test)。
let guardActive = false;
mock.module("../conversations/index", () => ({
  ...actualConversations,
  persistConversation: (conv: Conversation) => {
    if (!guardActive) return realPersistConversation(conv);
    persistedIds.push(conv.id);
  },
  deletePcConversations: (...args: Parameters<typeof realDeletePcConversations>) => {
    if (!guardActive) return realDeletePcConversations(...args);
  },
}));
mock.module("../conversations/auxiliary", () => ({
  ...actualAuxiliary,
  markOcrPendingParts: (...args: Parameters<typeof realMarkOcrPendingParts>) =>
    guardActive ? args[0] : realMarkOcrPendingParts(...args),
  attachOcrToImageParts: async (...args: Parameters<typeof realAttachOcrToImageParts>) => {
    if (!guardActive) return realAttachOcrToImageParts(...args);
    await ocrGate.promise;
    return args[0];
  },
}));
mock.module("../conversations/orchestrator", () => ({
  ...actualOrchestrator,
  generateAnswer: async (conv: Conversation, ...rest: unknown[]) => {
    if (!guardActive) return realGenerateAnswer(conv, ...(rest as []));
    generatedIds.push(conv.id);
  },
}));

const { handleConversationRoutes } = await import("./handlers/conversations");
const { deleteConversationsById } = await import("../conversations/helpers");

const priorState = state;

beforeAll(() => {
  guardActive = true;
  setState({
    settings: {
      assistantId: "a1",
      assistants: [{ id: "a1", name: "guard-test", chatModelId: null, presetMessages: [], regexes: [] }],
      chatModelId: "",
      providers: [],
    },
  } as unknown as State);
  configureWorkingSet({
    loadConversation: () => undefined,
    isGenerating: (id) => generating.has(id),
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

afterAll(() => {
  guardActive = false;
  setState(priorState);
  removeConversations(["g1-del", "g1-live"]);
});

function makeConversation(id: string): Conversation {
  const now = Date.now();
  return {
    id,
    assistantId: "a1",
    title: "guard",
    systemPrompt: null,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
  } as unknown as Conversation;
}

async function postMessage(conversationId: string): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1/api/conversations/${conversationId}/messages`);
  const request = new Request(url, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    headers: { "content-type": "application/json" },
  });
  return handleConversationRoutes(request, url, `conversations/${conversationId}/messages`);
}

async function settleContinuation() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("OCR 续体删除守卫(批6复审 G1)", () => {
  test("OCR 完成前删除会话:不复活(不再 persist)、不触发生成", async () => {
    ocrGate = deferred();
    persistedIds.length = 0;
    generatedIds.length = 0;
    const conv = makeConversation("g1-del");
    registerConversation(conv);

    const response = await postMessage(conv.id);
    expect(response?.status).toBe(202);
    // 同步段落库一次(用户消息入库,删除前的正常行为)
    expect(persistedIds).toEqual(["g1-del"]);

    // 删除流程自身会经 abortConversationGeneration 再 persist 一次(随后被
    // deletePcConversations 清掉,幂等无害)——以删除完成后的计数为基线。
    deleteConversationsById(new Set([conv.id]));
    const persistCountAfterDelete = persistedIds.length;

    ocrGate.resolve();
    await settleContinuation();

    // 守卫命中:续体丢弃结果——删除之后没有任何新 persist(复活),也没有 generateAnswer
    expect(persistedIds.length).toBe(persistCountAfterDelete);
    expect(generatedIds).toEqual([]);
  });

  test("未删除的正常路径:OCR 完成后落库并触发生成(守卫不误伤)", async () => {
    ocrGate = deferred();
    persistedIds.length = 0;
    generatedIds.length = 0;
    const conv = makeConversation("g1-live");
    registerConversation(conv);

    const response = await postMessage(conv.id);
    expect(response?.status).toBe(202);

    ocrGate.resolve();
    await settleContinuation();

    expect(persistedIds).toEqual(["g1-live", "g1-live"]);
    expect(generatedIds).toEqual(["g1-live"]);
  });
});
