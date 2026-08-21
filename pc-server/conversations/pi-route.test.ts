// conversations/pi-route.test.ts — generateAnswer 路由切换端到端(P3)
//
// 钉住编排器的三条 P3 不变式(方案 §六):
//   1) 工作区会话 → pi 引擎:回答落 parts、pi_session_file 列持久化、jsonl 真实存在;
//   2) 非工作区会话 → 聊天引擎原路(同一编排器入口,零 pi 痕迹);
//   3) 审批 API 全链路:pending 时生成保持在跑,POST tool-approval 原地放行,
//      不重触发生成(上游请求数不涨即硬证据)。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piroute-test-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { generating } = await import("./generation-state");
const { generateAnswer } = await import("./orchestrator");
const ws = await import("../workspace");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");
const { resolvePiSessionPath } = await import("../pi-engine/session-files");
const { pendingToolApprovalCount } = await import("../pi-engine/approval-gate");
const { handleConversationRoutes } = await import("../api/handlers/conversations");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

import type { Conversation, State } from "../foundation/types";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

const priorState = state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  setState(priorState);
  await Promise.all(servers.map((server) => server.close()));
});

/** 每用例独立假上游 + 独立 state(chatModelId 指向该上游),脚本互不串扰。 */
async function installUpstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const ourModel = model("fake-model", "Route Test Model");
  const ourProvider = provider({
    id: crypto.randomUUID(),
    name: "Route Test Provider",
    baseUrl: server.baseUrl,
    apiKey: "sk-test",
    enabled: true,
    models: [ourModel],
  });
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{ ...defaultAssistant(), id: "a1", name: "route-e2e" }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  next.settings.titleModelId = "";
  next.settings.suggestionModelId = "";
  setState(next as State);
  return server;
}

let seq = 0;
function seedConversation(workspaceId: string | null): Conversation {
  seq += 1;
  const now = Date.now();
  const conversation = {
    id: `piroute-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `已命名会话 ${seq}`,
    messages: [
      {
        id: `piroute-n-${seq}`,
        selectIndex: 0,
        messages: [
          {
            id: `piroute-m-${seq}`,
            role: "USER",
            parts: [{ type: "text", text: "请干活" }],
            annotations: [],
            createdAt: new Date(now).toISOString(),
            finishedAt: null,
            translation: null,
          },
        ],
      },
    ],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
    ...(workspaceId ? { workspaceId } : {}),
  } as unknown as Conversation;
  conversations.persistConversation(conversation);
  registerConversation(conversation);
  return conversation;
}

function lastAssistantMessage(conversation: Conversation) {
  const node = conversation.messages[conversation.messages.length - 1]!;
  return node.messages[node.selectIndex] ?? node.messages[0]!;
}

function partsText(conversation: Conversation): string {
  return (lastAssistantMessage(conversation).parts as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("generateAnswer P3 路由", () => {
  test("工作区会话走 pi 引擎:回答落 parts,pi_session_file 列持久化,jsonl 存在", async () => {
    await installUpstream([{ content: "工作区回答", usage: { prompt_tokens: 20, completion_tokens: 4 } }]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-pi" });
    const conversation = seedConversation(workspace.id);
    await generateAnswer(conversation);

    const answer = lastAssistantMessage(conversation);
    expect(partsText(conversation)).toContain("工作区回答");
    expect(answer.finishedAt).not.toBeNull();
    expect(conversation.piSessionFile).toBe(`${conversation.id}.jsonl`);
    expect(existsSync(resolvePiSessionPath(`${conversation.id}.jsonl`))).toBe(true);
    // 崩溃安全关联:列已随生成收尾落库(而不是只活在内存对象上)。
    expect(getConversationMeta(db, conversation.id)?.piSessionFile).toBe(`${conversation.id}.jsonl`);
    expect(generating.has(conversation.id)).toBe(false);
  }, 30_000);

  test("非工作区会话走聊天引擎原路:零 pi 痕迹", async () => {
    const server = await installUpstream([{ content: "聊天回答" }]);
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("聊天回答");
    expect(conversation.piSessionFile).toBeUndefined();
    expect(existsSync(resolvePiSessionPath(`${conversation.id}.jsonl`))).toBe(false);
    // 聊天引擎请求体特征:messages 含系统提示词(pi 路径的系统提示词是 pi 自建格式)。
    expect(server.requests.length).toBe(1);
  }, 30_000);

  test("审批 API 全链路:pending 原地放行,生成不重触发,文件落盘", async () => {
    const server = await installUpstream([
      { toolCalls: [{ id: "tc-route-w", name: "write", arguments: JSON.stringify({ path: "gated.txt", content: "via-api" }) }] },
      { content: "写完了" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-approval" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = seedConversation(workspace.id);

    const generation = generateAnswer(conversation);
    await waitUntil(() => pendingToolApprovalCount() === 1);

    const url = new URL(`http://localhost/api/conversations/${conversation.id}/tool-approval`);
    const response = await handleConversationRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: "tc-route-w", approved: true }),
      }),
      url,
      `conversations/${conversation.id}/tool-approval`,
    );
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ status: "accepted" });

    await generation;
    expect(readFileSync(join(workspace.root, "gated.txt"), "utf-8")).toBe("via-api");
    expect(partsText(conversation)).toContain("写完了");
    // 不重触发的硬证据:上游只收到两轮请求(工具轮 + 终局轮),没有第三次生成。
    expect(server.requests.length).toBe(2);
    const toolPart = (lastAssistantMessage(conversation).parts as Array<Record<string, unknown>>)
      .find((part) => part.type === "tool" && part.toolCallId === "tc-route-w") as
      | { approvalState?: { type?: string } }
      | undefined;
    expect(toolPart?.approvalState?.type).toBe("approved");
    expect(pendingToolApprovalCount()).toBe(0);
    expect(generating.has(conversation.id)).toBe(false);
  }, 30_000);
});
