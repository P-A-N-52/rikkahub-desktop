// conversations/pi-route.test.ts — generateAnswer 路由切换端到端(P3;P7 改 unified 断言)
//
// 钉住编排器的三条 P3 不变式(方案 §六),P7 起观测点从 jsonl 换成会话行数据:
//   1) 工作区会话 → pi 引擎:回答落 parts、保真注解(pi-fidelity)落消息、上下文从
//      DB 历史灌注回放(上游请求体携带历史即硬证据)、压缩记录字段就位;
//   2) 非工作区会话 → 聊天引擎原路(同一编排器入口,零 pi 痕迹);
//   3) 审批 API 全链路:pending 时生成保持在跑,POST tool-approval 原地放行,
//      不重触发生成(上游请求数不涨即硬证据)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piroute-test-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { generating } = await import("./generation-state");
const { compactEngineConversation, generateAnswer, resolveEngineForConversation } = await import("./orchestrator");
const ws = await import("../workspace");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");
const { pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
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

/** 每用例独立假上游 + 独立 state(chatModelId 指向该上游),脚本互不串扰。
 *  reasoningModel:给模型标 REASONING 能力(pi 侧映射 reasoning=true)——请求口径
 *  回归用(推理模型才触发 pi 的 developer 角色分支,见 model-bridge compat 覆盖)。
 *  maxTokens/systemPrompt:写进助手配置,跨引擎方言平价用例用(两引擎读同一配置)。 */
async function installUpstream(turns: FakeSseTurn[], opts?: { reasoningModel?: boolean; maxTokens?: number; systemPrompt?: string }) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const ourModel = model("fake-model", "Route Test Model");
  if (opts?.reasoningModel) ourModel.abilities.push("REASONING");
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
  next.settings.assistants = [{
    ...defaultAssistant(),
    id: "a1",
    name: "route-e2e",
    ...(opts?.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    ...(opts?.systemPrompt != null ? { systemPrompt: opts.systemPrompt } : {}),
  }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  next.settings.titleModelId = "";
  next.settings.suggestionModelId = "";
  setState(next as State);
  return server;
}

let seq = 0;
/** 追加一条 USER 消息节点(第二轮 prompt),返回该消息(断言/灌注校验用)。 */
function appendUserNode(conversation: Conversation, text: string) {
  const msg = {
    id: `piroute-m-u${seq}-${conversation.messages.length}`,
    role: "USER",
    parts: [{ type: "text", text }],
    annotations: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    translation: null,
  };
  conversation.messages.push({ id: `piroute-n-u${seq}-${conversation.messages.length}`, selectIndex: 0, messages: [msg] } as never);
  return msg as unknown as Conversation["messages"][number]["messages"][number];
}

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
  test("工作区会话走 pi 引擎:回答落 parts,保真注解落消息,上下文从 DB 灌注回放", async () => {
    const server = await installUpstream([{ content: "工作区回答" }, { content: "第二轮工作区回答" }]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-pi" });
    const conversation = seedConversation(workspace.id);
    await generateAnswer(conversation);

    const answer = lastAssistantMessage(conversation);
    expect(partsText(conversation)).toContain("工作区回答");
    expect(answer.finishedAt).not.toBeNull();
    // P7:引擎保真注解(P7 桥捕获)落在回答消息上——下一轮编码器靠它无损重建引擎消息。
    const fidelity = (answer.annotations ?? []).find(
      (item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "pi-fidelity",
    ) as { messages?: unknown } | undefined;
    expect(Array.isArray(fidelity?.messages)).toBe(true);
    // P7/T3:压缩记录字段就位(未触发自动压缩时保持 null——语义即"无压缩记录")。
    expect(conversation.engineCompactions ?? null).toBeNull();
    expect(getConversationMeta(db, conversation.id)?.engineCompactions ?? null).toBeNull();
    expect(generating.has(conversation.id)).toBe(false);

    // P7 灌注回放硬证据:追加第二轮用户消息再生成,上游第二请求必须携带
    // 第一轮的 prompt 与回答(历史从 DB 重建进引擎上下文,而不是靠 jsonl)。
    appendUserNode(conversation, "接着干活");
    await generateAnswer(conversation);
    expect(partsText(conversation)).toContain("第二轮工作区回答");
    const secondRequest = server.requests[1] as { messages?: Array<{ role: string; content?: unknown }> };
    const serialized = JSON.stringify(secondRequest?.messages ?? []);
    expect(serialized).toContain("请干活");
    expect(serialized).toContain("工作区回答");
    expect(serialized).toContain("接着干活");
  }, 30_000);

  test("推理模型的工作区请求:系统提示词恒 system 角色 + 上限恒 max_tokens(2.0.0 内测缺陷回归)", async () => {
    // 复现内测环境:第三方 OpenAI 兼容端点(假上游即"未知 baseUrl")+ 标 REASONING 的
    // 模型。修复前 pi 的 compat 自动探测按官方 OpenAI 假设:1)系统消息以 "developer"
    // 角色发出——DashScope 类 400 拒角色、火山方舟报 missing input.role;2)输出上限发
    // max_completion_tokens——第三方端点静默忽略未知字段,上限失效。修复(model-bridge
    // piCompatOverridesFor)后与聊天引擎同发 "system" + max_tokens。断言真实出站请求体,
    // 锁两引擎请求口径一致。
    const server = await installUpstream([{ content: "推理模型工作区回答" }], { reasoningModel: true });
    const workspace = ws.createWorkspace({ type: "managed", name: "route-reasoning-role" });
    const conversation = seedConversation(workspace.id);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("推理模型工作区回答");
    const request = server.requests[0] as {
      messages?: Array<{ role?: string }>;
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    const roles = (request?.messages ?? []).map((item) => item.role ?? "");
    expect(roles.length).toBeGreaterThan(0);
    expect(roles).toContain("system");
    expect(roles).not.toContain("developer");
    expect(request?.max_completion_tokens).toBeUndefined();
    expect(request?.max_tokens).toBeGreaterThan(0);
  }, 30_000);

  test("跨引擎请求方言平价:chat 与 pi 对同一第三方上游,系统角色/上限字段/上限数值逐字一致(T4.7)", async () => {
    // 统一请求方言(model-providers/request-dialect)的层3回归:同一助手配置
    // (maxTokens=1024 + 系统提示词)驱动两个引擎打同一个假上游,断言真实出站请求体的
    // 方言字段完全一致——聊天引擎由构建体直接消费方言,pi 经 model-bridge compat 翻译,
    // 两条翻译路径必须收敛到同一字节。任一引擎将来漂移(如 pi 升级改探测默认),此测试先红。
    const server = await installUpstream(
      [{ content: "chat 侧回答" }, { content: "pi 侧回答" }],
      { reasoningModel: true, maxTokens: 1024, systemPrompt: "平价测试系统提示词" },
    );
    const chatConversation = seedConversation(null);
    await generateAnswer(chatConversation);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-dialect-parity" });
    const piConversation = seedConversation(workspace.id);
    await generateAnswer(piConversation);

    expect(partsText(chatConversation)).toContain("chat 侧回答");
    expect(partsText(piConversation)).toContain("pi 侧回答");
    expect(server.requests.length).toBe(2);
    for (const request of server.requests as Array<{
      messages?: Array<{ role?: string }>;
      max_tokens?: number;
      max_completion_tokens?: number;
    }>) {
      const roles = (request.messages ?? []).map((item) => item.role ?? "");
      expect(roles).toContain("system");
      expect(roles).not.toContain("developer");
      expect(request.max_completion_tokens).toBeUndefined();
      expect(request.max_tokens).toBe(1024);
    }
  }, 30_000);

  test("非工作区会话走聊天引擎原路:零 pi 痕迹", async () => {
    const server = await installUpstream([{ content: "聊天回答" }]);
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("聊天回答");
    // P7/T3:聊天引擎会话没有 engineCompactions 字段(工作区引擎专属),保真注解也不会出现。
    expect(conversation.engineCompactions).toBeUndefined();
    const answer = lastAssistantMessage(conversation);
    expect((answer.annotations ?? []).some(
      (item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "pi-fidelity",
    )).toBe(false);
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

describe("引擎判定单源(审批旁路/压缩路由收编)", () => {
  test("resolveEngineForConversation:工作区会话命中 pi,普通会话落 chat 兜底", async () => {
    await installUpstream([{ content: "未使用" }]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-resolve" });

    // 审批端点(tool-approval)据 resumeSemantics 决定"记录状态"还是"重触发续跑",
    // 压缩端点据 compact 有无决定"引擎压缩"还是"回落 UI 历史压缩"——这里锁死两个
    // 引擎的声明,防止 adapter 改动悄悄改变端点行为。
    const piAdapter = resolveEngineForConversation(seedConversation(workspace.id));
    expect(piAdapter.kind).toBe("pi");
    expect(piAdapter.resumeSemantics).toBe("run-and-suspend");
    expect(typeof piAdapter.compact).toBe("function");

    const chatAdapter = resolveEngineForConversation(seedConversation(null));
    expect(chatAdapter.kind).toBe("chat");
    expect(chatAdapter.resumeSemantics).toBe("pause-resume");
    expect(chatAdapter.compact).toBeUndefined();
  }, 30_000);

  test("compactEngineConversation:普通会话回落(null),工作区会话穿透到 pi 压缩驱动", async () => {
    await installUpstream([{ content: "未使用" }]);
    // chat 无 compact 能力 → null,调用方(compress 端点)回落 UI 历史压缩。
    expect(await compactEngineConversation(seedConversation(null), "")).toBeNull();

    // 工作区会话:注册表命中 pi adapter → runtime 透传 → 压缩装配(富化/资源)→
    // pi session.compact。小会话在发起任何模型请求前抛"记忆还很小"(runner 已映射
    // 成人话)——该错误文本即"路由穿透到引擎压缩驱动"的硬证据,且全程无上游请求。
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact" });
    const conversation = seedConversation(workspace.id);
    await expect(compactEngineConversation(conversation, "")).rejects.toThrow("引擎记忆还很小");
  }, 30_000);
});
