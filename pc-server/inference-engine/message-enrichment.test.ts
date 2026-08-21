// inference-engine/message-enrichment.test.ts — 引擎无关富化层契约测试
//
// 锁定四件套的共享裁决:模板渲染一次到位、时间提醒间隔语义、lorebook/模式注入
// 按位置分流(系统位文本 vs 聊天位插队)、滞回截断窗口、二次富化幂等(合成消息
// 按 syntheticIds 剥除后不重复注入)。聊天引擎与 pi 引擎共用此层,行为必须逐字一致。

import { describe, expect, test, beforeAll } from "bun:test";
import type { Assistant, Conversation, Message, State } from "../foundation/types";
import { message } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { enrichMessages, encodableMessages, truncationStartFor } from "./message-enrichment";

beforeAll(() => {
  setState({
    settings: {
      displaySetting: { userNickname: "Test User" },
      lorebooks: [],
      modeInjections: [],
      chatModelId: "m1",
    },
  } as unknown as State);
});

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    chatModelId: null,
    name: "Test Assistant",
    avatar: { type: "dummy" },
    useAssistantAvatar: false,
    tags: [],
    systemPrompt: "You are helpful.",
    temperature: null,
    topP: null,
    contextMessageLimit: 0,
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    mcpToolOverrides: {},
    localTools: [],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
    allowConversationPromptInjection: false,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    modeInjectionIds: [],
    lorebookIds: [],
    workspaceId: null,
    workspaceCwd: null,
    piCompactions: null,
    ...overrides,
  };
}

function userMessage(text: string, createdAt: string): Message {
  const msg = message("USER", [{ type: "text", text }]);
  msg.createdAt = createdAt;
  return msg;
}

function assistantMessage(text: string, createdAt: string): Message {
  const msg = message("ASSISTANT", [{ type: "text", text }], "m1");
  msg.createdAt = createdAt;
  return msg;
}

const model = {
  id: "m1",
  modelId: "test-model",
  displayName: "Test Model",
  type: "CHAT" as const,
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  abilities: [],
  tools: [],
};

describe("message-enrichment", () => {
  test("模板渲染:{{message}} 占位符在富化层一次到位,调用方不再二次包装", () => {
    const a = assistant({ messageTemplate: "User said: {{ message }}" });
    const result = enrichMessages([userMessage("hello", "2026-08-22T10:00:00Z")], {
      conversation: conversation(),
      assistant: a,
      model,
    });
    expect(result.messages[0].parts[0]).toMatchObject({ type: "text", text: "User said: hello" });
  });

  test("时间提醒:首条 USER 恒提醒,间隔 >1h 再提醒,<1h 不提醒", () => {
    const a = assistant({ enableTimeReminder: true });
    const base = [
      userMessage("first", "2026-08-22T10:00:00Z"),
      assistantMessage("reply", "2026-08-22T10:01:00Z"),
      userMessage("second", "2026-08-22T10:30:00Z"), // 30min 后,不提醒
      assistantMessage("reply2", "2026-08-22T10:31:00Z"),
      userMessage("third", "2026-08-22T12:00:00Z"), // 1.5h 后,提醒
    ];
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    const reminders = result.messages.filter((msg) => result.syntheticIds.has(msg.id));
    expect(reminders).toHaveLength(2);
    expect(reminders[0].parts[0]).toMatchObject({ type: "text" });
    expect(String((reminders[0].parts[0] as { text: string }).text)).toContain("<time_reminder>");
    expect(String((reminders[1].parts[0] as { text: string }).text)).toContain("since last message");
  });

  test("滞回截断:contextMessageLimit 超限按步长量化前移", () => {
    expect(truncationStartFor(10, 0)).toBe(0); // 无限制
    expect(truncationStartFor(10, 10)).toBe(0); // 未超
    expect(truncationStartFor(11, 10)).toBe(0); // 超 1,step=2,floor(1/2)*2=0
    expect(truncationStartFor(12, 10)).toBe(2); // 超 2,起点=2
    expect(truncationStartFor(13, 10)).toBe(2); // 超 3,floor(3/2)*2=2
    expect(truncationStartFor(14, 10)).toBe(4); // 超 4,起点=4
    const a = assistant({ contextMessageLimit: 2 });
    const base = [
      userMessage("m1", "2026-08-22T10:00:00Z"),
      assistantMessage("r1", "2026-08-22T10:01:00Z"),
      userMessage("m2", "2026-08-22T10:02:00Z"),
      assistantMessage("r2", "2026-08-22T10:03:00Z"),
      userMessage("m3", "2026-08-22T10:04:00Z"),
    ];
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    // limit=2,5 条 → step=ceil(2×0.2)=1,start = floor((5-2)/1)*1 = 3,保留 r2/m3
    expect(result.messages.map((msg) => (msg.parts[0] as { text?: string }).text)).toEqual(["r2", "m3"]);
  });

  test("幂等二次富化:按 syntheticIds 剥除后,合成消息不重复产生", () => {
    const a = assistant({ enableTimeReminder: true });
    const base = [userMessage("hello", "2026-08-22T10:00:00Z")];
    const first = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    expect(first.syntheticIds.size).toBe(1);
    // 第二轮:把第一轮产物(含合成提醒)再喂进来,剥除后重新富化
    const second = enrichMessages(first.messages, {
      conversation: conversation(),
      assistant: a,
      model,
      stripSyntheticIds: first.syntheticIds,
    });
    // 合成消息被剥除后重新生成,总数不变、id 不同(新对象)
    expect(second.syntheticIds.size).toBe(1);
    expect([...second.syntheticIds][0]).not.toBe([...first.syntheticIds][0]);
    expect(second.messages).toHaveLength(first.messages.length);
  });

  test("encodableMessages:合成消息被剥除,真实消息保留(模板已渲染)", () => {
    const a = assistant({ enableTimeReminder: true, messageTemplate: "Q: {{ message }}" });
    const base = [userMessage("hello", "2026-08-22T10:00:00Z")];
    const enriched = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    const encodable = encodableMessages(enriched.messages, enriched.syntheticIds);
    expect(encodable).toHaveLength(1);
    expect(encodable[0].parts[0]).toMatchObject({ type: "text", text: "Q: hello" });
    expect(encodableMessages(enriched.messages, new Set()).length).toBeGreaterThan(1); // 不剥则含提醒
  });
});
