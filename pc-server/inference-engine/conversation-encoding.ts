// inference-engine/conversation-encoding.ts — 会话 → 三家 Provider 请求体的编码层
// （模板变量、提示词注入、OpenAI messages / Responses API input / Google contents 构建）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, getStringArray, message, renderTemplate, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { activePromptInjections as activePromptInjectionsCore, applyMessageTemplateToParts, applyPromptInjectionsToMessages, templateVariables as templateVariablesCore } from "../assistants";
import { frozenContextBlocks } from "./context-snapshots";
import { buildSearchContext } from "../search";
import { findModel } from "../model-providers";
import { listSkills } from "../tools/skills";
import { conversationFunctionTools } from "../tools/bound";
import { GOOGLE_SAFETY_SETTINGS, apiContentFromParts, apiContentText, appendAssistantApiMessages, googleContentsFromApiMessages, googleFunctionDeclarations, googleGenerationConfig, hasBuiltInTool, responseApiMessagesFromUiMessages, supportsAbility, supportsOutputModality } from "./message-builder";
import { isEmptyAssistantPlaceholder } from "./parts";

export function templateVariables(messageText: string, role: string, assistant: Assistant, modelItem: Model, at?: Date) {
  return templateVariablesCore(
    messageText,
    role,
    assistant,
    modelItem,
    String(state.settings.displaySetting.userNickname ?? "").trim() || "User",
    at,
  );
}

// P1-1:消息自身时间戳。无效/缺失时返回 undefined 回退“此刻”——Intl 对 Invalid Date
// 会抛 RangeError,必须在这里拦住。
function messageTimestamp(msg: Message): Date | undefined {
  const parsed = Date.parse(String(msg.createdAt ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function activePromptInjections(conversation: Conversation, assistant: Assistant, messages: Message[]) {
  // 专题9:助手开启"允许会话级注入绑定"时,生效 id 集来自会话字段(完全取代助手级集合,
  // 包括空集),对齐安卓 PromptInjectionTransformer.collectInjections 的 effective ids。
  const override = assistant.allowConversationPromptInjection === true
    ? {
        modeInjectionIds: getStringArray(conversation.modeInjectionIds),
        lorebookIds: getStringArray(conversation.lorebookIds),
      }
    : undefined;
  return activePromptInjectionsCore(assistant, messages, state.settings.lorebooks, state.settings.modeInjections, override);
}

function timeReminderContent(current: Message, previous?: Message) {
  const currentTime = new Date(current.createdAt);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(currentTime);
  const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(currentTime);
  if (!previous) return `<time_reminder>Current time: ${weekday}, ${timeText}</time_reminder>`;
  const gapSeconds = Math.floor((Date.parse(current.createdAt) - Date.parse(previous.createdAt)) / 1000);
  // createdAt 不可解析时 gapSeconds 为 NaN(NaN<=3600 为 false),原实现会输出 "NaN d",
  // 用否定式条件一并挡掉;间隔 <=1h 不提醒,故不存在分钟级分支。
  if (!(gapSeconds > 3600)) return "";
  const gapText = gapSeconds < 86400
    ? `${Math.floor(gapSeconds / 3600)} h`
    : `${Math.floor(gapSeconds / 86400)} d`;
  return `<time_reminder>Current time: ${weekday}, ${timeText} (${gapText} since last message)</time_reminder>`;
}

function buildSkillsContext(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return "";
  const body = available
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n");
  return `**Skills**
You have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.
<available_skills>
${body}
</available_skills>`;
}

export function buildGoogleRequestBody(messagesForApi: ApiMessage[], modelItem: Model, assistant: Assistant) {
  const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
  const hasImageOutput = supportsOutputModality(modelItem, "IMAGE");
  const functionTools = supportsAbility(modelItem, "TOOL")
    ? conversationFunctionTools(assistant)
    : [];
  const functionDeclarations = googleFunctionDeclarations(functionTools);
  // 内置工具（googleSearch/urlContext）目前与函数工具互斥，优先内置工具，镜像安卓
  // buildCompletionRequestBody:446-468（model.tools 覆盖 functionDeclarations）。
  const builtInTools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) builtInTools.push({ googleSearch: {} });
  if (hasBuiltInTool(modelItem, "url_context") || hasBuiltInTool(modelItem, "urlContext")) {
    builtInTools.push({ urlContext: {} });
  }
  const tools = builtInTools.length
    ? builtInTools
    : functionDeclarations.length
      ? [{ functionDeclarations }]
      : undefined;
  const body: Record<string, JsonValue> = {
    // system 在图片输出模型上不发送，对齐安卓 buildCompletionRequestBody:352。
    ...(systemContent && !hasImageOutput
      ? { systemInstruction: { parts: [{ text: apiContentText(systemContent) }] } }
      : {}),
    generationConfig: googleGenerationConfig(modelItem, assistant),
    contents: googleContentsFromApiMessages(messagesForApi),
    ...(tools ? { tools } : {}),
    safetySettings: GOOGLE_SAFETY_SETTINGS,
  };
  return body;
}

// 按工具边界把 ASSISTANT 消息的 parts 分组。镜像安卓
// ai/src/main/java/me/rerere/ai/provider/providers/ProviderMessageUtils.kt 的
// groupPartsByToolBoundary：连续的"已执行 tool" parts 合为一组，与它们之前的
// content（含 reasoning）共同组成一条 assistant 消息，避免把同一个 reasoning
// 在多次 tool flush 中提前清空——这是 DeepSeek V4 thinking 模式要求每条带
// tool_calls 的 assistant 消息都必须携带 reasoning_content 的核心修复点。
function conversationTransformedMessages(conversation: Conversation, assistant: Assistant) {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 1.5.0 跟进安卓 Migration_16_17:truncateIndex("清除上下文"分割线)机制废弃,
  // 上下文裁剪只剩两条正交机制——助手级 contextMessageLimit 切片 + 压缩对话历史。
  const visibleNodes = conversation.messages;
  // 剔除尾部"正在生成"的空 ASSISTANT 占位后再按 contextMessageLimit 切片,见
  // isEmptyAssistantPlaceholder 的说明(issue #16 + 工具恢复兼容)。
  const contextNodes = visibleNodes.filter((node, index) => {
    if (index !== visibleNodes.length - 1) return true;
    const selected = node.messages[node.selectIndex] ?? node.messages[0];
    return !isEmptyAssistantPlaceholder(selected);
  });
  // 专题11-P2-1:上下文窗口“向上滞回”批量截断,替代逐轮滑动。旧逻辑 slice(-limit)
  // 每轮把窗口起点前移一条 → 前缀每轮都变,跨轮缓存全灭。现在起点按步长
  // S=ceil(limit×0.2) 量化前移:窗口在 limit ~ limit+S-1 条之间波动(只多给不少给,
  // limit 是给用户的下限承诺),起点每 S 轮才动一次,期间跨轮缓存可命中。
  const contextLimit = assistant.contextMessageLimit;
  const truncationStep = Math.max(1, Math.ceil(contextLimit * 0.2));
  const truncationStart = contextLimit > 0 && contextNodes.length > contextLimit
    ? Math.floor((contextNodes.length - contextLimit) / truncationStep) * truncationStep
    : 0;
  const rawMessages = contextNodes.slice(truncationStart);
  const selectedMessages = rawMessages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
  const conversationSystemPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  const effectiveSystemPrompt = conversationSystemPrompt || assistant.systemPrompt.trim();
  // 专题11-P1-2:system 各区块按“稳定→易变”排列。专题12 进一步把记忆/最近会话
  // 冻结为会话级快照(context-snapshots.ts)——它们在 system 里一变,后面整个会话
  // 历史的前缀缓存都会失效;冻结后同一会话内 system 逐字节不变。
  // P6 退役:原居首的工作区段(buildWorkspacePromptSegment)已移除——它与生成路由
  // 同用 workspaceRuntimeForConversation 判定,工作区可用必走 pi 会话(agent 身份由
  // pi 系统提示词+appendSystemPrompt 承载),不可用时该段本就返回空串,两头皆死代码。
  const systemParts = [
    effectiveSystemPrompt
      ? renderTemplate(effectiveSystemPrompt, templateVariables("", "system", assistant, picked.model))
      : "",
    buildSkillsContext(assistant),
    buildSearchContext(),
    ...frozenContextBlocks(assistant, conversation.id),
  ].filter(Boolean);

  const internalMessages: Message[] = [];
  if (systemParts.length) {
    internalMessages.push(message("SYSTEM", [{ type: "text", text: systemParts.join("\n\n") }]));
  }
  internalMessages.push(...selectedMessages.map((msg) => cloneJson(msg)));

  const messagesAfterTimeReminder: Message[] = [];
  let firstUserReminderInjected = false;
  for (let index = 0; index < internalMessages.length; index += 1) {
    const selected = internalMessages[index];
    if (assistant.enableTimeReminder && selected.role === "USER") {
      const previous = firstUserReminderInjected && index > 0 ? internalMessages[index - 1] : undefined;
      const reminder = timeReminderContent(
        selected,
        previous,
      );
      if (reminder) messagesAfterTimeReminder.push(message("USER", [{ type: "text", text: reminder }]));
      firstUserReminderInjected = true;
    }
    messagesAfterTimeReminder.push(selected);
  }

  const injections = activePromptInjections(conversation, assistant, messagesAfterTimeReminder);
  return { messages: applyPromptInjectionsToMessages(messagesAfterTimeReminder, injections), picked };
}

export function conversationMessagesForApi(
  conversation: Conversation,
  assistant: Assistant,
  // 对齐安卓 commit e63d017：OpenAI providerSetting.includeHistoryReasoning
  // 控制是否把历史 assistant 消息的 reasoning_content 回传给上游。默认 true，
  // 与安卓 ChatCompletionsAPI.buildMessages 的默认值一致。
  includeHistoryReasoning: boolean = true,
) {
  const template = assistant.messageTemplate?.trim() || "{{ message }}";
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);

  const items: ApiMessage[] = [];
  for (const selected of transformedMessages) {
    if (selected.role === "ASSISTANT") {
      appendAssistantApiMessages(
        items,
        {
          ...selected,
          parts: applyMessageTemplateToParts(selected.parts, "assistant", template, messageTimestamp(selected)),
        },
        includeHistoryReasoning,
      );
      continue;
    }
    const rawContent = textFromParts(selected.parts);
    const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : "user";
    const messageAt = messageTimestamp(selected);
    const placeholderParts = selected.parts.map((part) =>
      part.type === "text"
        ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, picked.model, messageAt)) }
        : part,
    );
    const templatedParts = applyMessageTemplateToParts(placeholderParts, role, template, messageAt);
    const content = apiContentFromParts(templatedParts, rawContent, picked.model);
    if (!content) continue;
    items.push({ role, content });
  }
  return items;
}

export function conversationResponseApiInput(conversation: Conversation, assistant: Assistant) {
  const template = assistant.messageTemplate?.trim() || "{{ message }}";
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  const converted = transformedMessages
    .map((selected) => {
      if (selected.role === "ASSISTANT") {
        return {
          ...selected,
          parts: applyMessageTemplateToParts(selected.parts, "assistant", template, messageTimestamp(selected)),
        };
      }
      const rawContent = textFromParts(selected.parts);
      const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : "user";
      const messageAt = messageTimestamp(selected);
      const placeholderParts = selected.parts.map((part) =>
        part.type === "text"
          ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, picked.model, messageAt)) }
          : part,
      );
      return {
        ...selected,
        parts: applyMessageTemplateToParts(placeholderParts, role, template, messageAt),
      };
    });
  return responseApiMessagesFromUiMessages(converted, picked.model);
}

export function conversationResponseApiInstructions(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  return transformedMessages
    .filter((item) => item.role === "SYSTEM")
    .map((item) =>
      applyPlaceholders(
        textFromParts(item.parts),
        templateVariables(textFromParts(item.parts), "system", assistant, picked.model),
      )
    )
    .filter(Boolean)
    .join("\n");
}
