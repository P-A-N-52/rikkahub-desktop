// conversations/orchestrator.ts — 会话生成编排（Provider 分发、流式工具循环挂接、生成主链路与收尾任务）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。推理引擎经 GenerationEvent sink 与本层解耦。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, MessageNode, Model, Provider, ToolPendingOutput } from "../foundation/types";
import { bumpAnalyticsErrCount } from "../app-config/analytics";
import type { GenerationEventSink, StreamHooksWithSink, ToolExecutor } from "../inference-engine/events";
import { id, isRecord, message, textFromParts } from "../foundation/utils";
import { classifyProxyError } from "../foundation/net";
import { classifyContextOverflowError, classifyRateLimitError } from "../inference-engine/provider-errors";
import { state } from "../persistence/json-store";
import { addLog } from "../api/logs";
import { broadcastConversation, broadcastEngineStatus, broadcastList, broadcastNodeUpdate, touchStream } from "../api/sse";
import { applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { endpointFor } from "../model-providers/checks";
import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  reasoningLevelNormalized,
  reasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiIncludeForProvider,
  responseApiReasoningForProvider,
  supportsAbility,
} from "../inference-engine/message-builder";
import {
  buildGoogleRequestBody,
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationResponseApiInstructions,
} from "../inference-engine/conversation-encoding";
import {
  fetchClaudeTextWithTools,
  fetchOpenAiText,
  fetchOpenAiTextStreaming,
  fetchText,
  lookupContextLimit,
  lookupOutputLimit,
  modelsDevCache,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "../inference-engine/providers";
import {
  finishReasoningParts,
  setMessageLoading,
  streamStartedMessages,
} from "../inference-engine/parts";
import { createGenerationEventApplier } from "./generation-apply";
import { apiToolCallFromPart, resolvedToolOutput, toolExecutionErrorPayload } from "../tools/format";
import { conversationFunctionTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import { runPiCompaction, runPiGeneration, type CapturedPiCompaction } from "../pi-engine/runner";
import { createPiWorkspaceTools } from "../pi-engine/workspace-tools";
import { createPiGeneralTools } from "../pi-engine/general-tools";
import { createPiSessionResources } from "../pi-engine/resources";
import { piPromptInputFromParts } from "../pi-engine/attachments";
import type { PiCompactionRecord } from "../pi-engine/context-encoder";
import { applyOutputTransforms } from "../assistants";
import { TITLE_CHARACTER_LIMIT } from "../app-config/prompts";
import { flushConvDirtyNow, getConversation, getConversationsDb, markConversationRowDirty, markMessageNodeDirty, persistConversation, scheduleThrottledConvFlush } from "./index";
import { checkoutConversation, releaseConversation } from "./working-set";
import { conversationExistsInDb } from "./read-queries";
import { reportError } from "../observability/app-errors";
import { generating } from "./generation-state";
import {
  appendTextPart,
  canResumeToolExecution,
  ensureUsage,
  findAssistant,
  finishMessage,
  hasPendingToolApproval,
  hasResumableToolParts,
  toolApprovalType,
} from "./helpers";
import { generateSuggestionsForConversation, generateTitleForConversation, limitAuxiliaryText, modelExists, shouldAutoGenerateTitle } from "./auxiliary";

/** 生成入口一次性解析的配置快照（P1-4）。流式生成横跨多个 await 点，用户中途改配置
 *  （换模型/改工具集/删助手）时，updateSettings 会整体替换 state.settings——持有入口
 *  时刻的引用即天然快照（旧对象不会被原地修改），保证同一次生成读到同一代配置。 */
export interface GenerationSnapshot {
  assistant: Assistant;
  provider: Provider;
  model: Model;
}

export async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
  snapshot?: GenerationSnapshot,
) {
  const assistant = snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = snapshot
    ? { provider: snapshot.provider, model: snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, picked.model);
  // 对齐 e63d017：OpenAI 路径才让 includeHistoryReasoning 生效；
  // claude/google 不走 OpenAI assistant 序列化，一律保持 true。
  const includeHistoryReasoning =
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true;
  const messagesForApi = conversationMessagesForApi(conversation, assistant, includeHistoryReasoning);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    // issue10：Gemini 鉴权走 x-goog-api-key 头（与安卓非 Vertex 路径、Cherry Studio 一致）。
    // 此前用 ?key= query，官方两者都收，但主流中转网关只解析 header，query 会被判 invalid key。
    headers["x-goog-api-key"] = providerItem.apiKey;
    const baseUrl = providerItem.baseUrl;
    body = buildGoogleRequestBody(messagesForApi, picked.model, assistant);
    const finalBody = applyCustomBody(body, assistant, picked.model);
    // 有 hooks（来自会话）时走 SSE 流式 + 工具循环；辅助调用无 hooks 时退回非流式。
    if (hooks?.message != null) {
      return streamGoogleChatWithTools(baseUrl, headers, selectedModel, finalBody, providerItem, assistant, signal, hooks);
    }
    const googleUrl = `${baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    return fetchText(googleUrl, headers, finalBody, providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") ?? "", signal);
  }

  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = messagesForApi;
    const systemContent = messages.find((item) => item.role === "system")?.content;
    const functionTools = supportsAbility(picked.model, "TOOL")
      ? conversationFunctionTools(assistant)
      : [];
    const claudeTools = claudeToolsFromOpenAiTools(functionTools, providerItem);
    const normalizedReasoning = reasoningLevelNormalized(assistant.reasoningLevel);
    const reasoningActive = supportsAbility(picked.model, "REASONING") && normalizedReasoning !== "off";
    // Always stream when invoked from a conversation (hooks present). The streaming path handles
    // text + thinking + tool_use deltas live, matching Android (ClaudeProvider.streamText). The
    // non-streaming fallback only runs for auxiliary calls without hooks (title/translate, etc.).
    const canStream = hooks?.message != null;
    body = {
      model: selectedModel,
      max_tokens: assistant.maxTokens ?? 64_000,
      stream: canStream,
      system: claudeSystemContent(systemContent, providerItem),
      messages: claudeMessagesFromApiMessages(messages, providerItem),
      // 顶层 cache_control: 让 Anthropic 自动管理缓存断点
      // 对齐安卓 ClaudeProvider.kt:275-278 (commit d2e52106)
      ...(providerItem.promptCaching === true
        ? { cache_control: claudeCacheControlEphemeral(providerItem) }
        : {}),
      ...(assistant.temperature != null && !reasoningActive ? { temperature: assistant.temperature } : {}),
      ...(assistant.topP != null ? { top_p: assistant.topP } : {}),
      // thinking + output_config：DeepSeek 走 Claude 格式时用 display:"raw" 展示原始思维链
      ...claudeThinkingPayload(picked.model, assistant.reasoningLevel),
      ...(claudeTools.length ? { tools: claudeTools } : {}),
    };
    if (canStream) {
      return streamClaudeChatWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  if (providerItem.useResponseApi) {
    const functionTools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant) : [];
    const builtInTools = responseApiBuiltInTools(picked.model);
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    body = {
      model: selectedModel,
      stream: false,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
      tools: [
        ...functionTools.map((tool: any) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    return fetchText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant) : [];
  body = {
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
  };
  return fetchOpenAiText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
}

export async function callProviderStreaming(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  ctx: { signal?: AbortSignal; sink: GenerationEventSink; executeTool: ToolExecutor; snapshot?: GenerationSnapshot },
): Promise<string> {
  const assistant = ctx.snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = ctx.snapshot
    ? { provider: ctx.snapshot.provider, model: ctx.snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", Authorization: `Bearer ${providerItem.apiKey}` },
    assistant,
    providerItem,
    picked.model,
  );
  const messagesForApi = conversationMessagesForApi(
    conversation,
    assistant,
    // 对齐 e63d017：OpenAI 类型 provider 才尊重 includeHistoryReasoning 选项；
    // 默认 true，仅当用户显式关闭时才不回传历史 reasoning_content。
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true,
  );
  const tools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant) : [];
  const hooks: StreamHooksWithSink = {
    message: assistantMessage,
    conversation,
    node: assistantNode,
    sink: ctx.sink,
    executeTool: ctx.executeTool,
  };
  if (providerItem.type !== "openai") {
    // 把本函数已解析的快照透传，确保 claude/google 路径与 openai 路径读到同一代配置
    return callProvider(conversation, ctx.signal, hooks, { assistant, provider: picked.provider, model: picked.model });
  }
  if (providerItem.useResponseApi) {
    const responseTools = [
      ...tools.map((tool: any) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      ...responseApiBuiltInTools(picked.model),
    ];
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    const body = applyCustomBody({
      model: selectedModel,
      stream: true,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
      tools: responseTools.length ? responseTools : undefined,
    }, assistant, picked.model);
    return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
  }
  const body = applyCustomBody({
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
    stream: true,
    stream_options: hostOfProvider(providerItem) === "api.mistral.ai" ? undefined : { include_usage: true },
  }, assistant, picked.model);
  return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
}

export async function executeApprovedToolPart(
  part: Record<string, JsonValue>,
  assistant: Assistant,
  context?: { conversationId?: string; messageNodeId?: string; signal?: AbortSignal },
) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  // 走到这里 = 用户对 pending 卡显式批准：userApproved 是危险命令拦截的
  // 知情同意放行门（workspace/runtime.ts），仅此路径可置 true。
  return executeToolCall(apiToolCallFromPart(part), assistant, { ...context, userApproved: true });
}

export async function resumeApprovedToolParts(
  conversation: Conversation,
  assistant: Assistant,
  assistantMessage: Message,
  assistantNode: MessageNode,
  useResponseInput: boolean,
  signal?: AbortSignal,
) {
  const toolMessages: ApiMessage[] = [];
  let changed = false;
  for (const part of assistantMessage.parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    if (Array.isArray(part.output) && part.output.length > 0) continue;
    if (!canResumeToolExecution(part)) continue;
    let toolResult: unknown;
    try {
      toolResult = await executeApprovedToolPart(part, assistant, {
        conversationId: conversation.id,
        messageNodeId: assistantNode.id,
        signal,
      });
    } catch (err) {
      toolResult = toolExecutionErrorPayload(err);
    }
    const normalized = await toolResultToParts(toolResult);
    part.output = await realizeToolResult(normalized);
    changed = true;
    toolMessages.push(
      useResponseInput
        ? { type: "function_call_output", call_id: String(part.toolCallId ?? ""), output: resolvedToolOutput(part) }
        : { role: "tool", tool_call_id: String(part.toolCallId ?? ""), content: resolvedToolOutput(part) },
    );
  }
  if (changed) {
    conversation.updateAt = Date.now();
    touchStream({ message: assistantMessage, conversation, node: assistantNode });
  }
  return toolMessages;
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

// 批6复审 G2:当前生成流正在写的消息(按会话)。R2-3 的入口接管 abort 后,旧流异步退出,
// 若新流经 ensureAssistantGenerationNode 复用了同一空占位消息,旧流的收尾不得再触碰它。
// generating 登记判定"是否被接管",本记录判定"新流是否复用了同一消息对象"。
const activeGenerationMessages = new Map<string, Message>();

function completeConversationGeneration(conversationId: string, controller: AbortController) {
  const current = generating.get(conversationId);
  if (current !== controller) {
    // 已被接管(current 为新流 controller):所有权归新流,不得清。
    // 登记被外部清除(stop/删会话,current 为空):顺手清所有权记录,防陈旧 Message 引用滞留。
    if (!current) activeGenerationMessages.delete(conversationId);
    return;
  }
  generating.delete(conversationId);
  activeGenerationMessages.delete(conversationId);
  // The generating Map drives the sidebar's per-conversation streaming indicator
  // (rendered via the conversations-list SSE). Now that broadcastNodeUpdateNow no
  // longer pings the list on every chunk (see comment at api/sse.ts scheduleNodeBroadcast), we have
  // to explicitly refresh on the false→true and true→false transitions so the
  // indicator turns on/off. Caller `generateAnswer` calls broadcastConversation
  // at start which already touches broadcastList, and we cover the end transition
  // right here.
  broadcastList();
  // 1.2.6:流式结束,全量 reconcile 活库——刷残余脏标记 + persistConversation,把流式
  // 期间增量 upsert 的节点和任何新增/删除的节点统一对齐(清孤立节点行)。幂等
  // (upsert 会话行 + 删旧节点 + 重插)。会话已被并发删除时跳过;flushConvDirty
  // 也会跳过已删会话的脏标记。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

function conversationStillExists(conversationId: string) {
  // DB-first 批1:直查活库。新建会话即时落库(ensureConversation 1.2.6 起),无漏检窗口。
  const db = getConversationsDb();
  return db ? conversationExistsInDb(db, conversationId) : false;
}

async function runPostGenerationTasks(conversationId: string, snapshot: Conversation, assistantMessageId: string) {
  const liveConversation = () => getConversation(conversationId);
  if (shouldAutoGenerateTitle(snapshot) && modelExists(state.settings.titleModelId)) {
    try {
      const title = await generateTitleForConversation(snapshot);
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        live.title = title;
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch (titleError) {
      addLog({
        providerId: "",
        providerName: "RikkaHub PC",
        url: "conversation:title",
        ok: false,
        status: 0,
        kind: "aux:title",
        error: titleError instanceof Error ? titleError.message : String(titleError),
      });
      reportError("provider", "warn", "标题自动生成失败，已回退为首条消息文本", titleError, "title_generation_failed");
      // Title generation failed → fall back to first user message text (Android parity).
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
        const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  } else if (shouldAutoGenerateTitle(snapshot)) {
    // No title model configured at all → still give it a sensible name from the first user message.
    const live = liveConversation();
    if (live && shouldAutoGenerateTitle(live)) {
      const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
      const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
      if (fallback !== live.title) {
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  }

  if (modelExists(state.settings.suggestionModelId)) {
    try {
      const suggestions = await generateSuggestionsForConversation(snapshot);
      const live = liveConversation();
      const lastNode = live?.messages[live.messages.length - 1];
      const lastMessage = lastNode?.messages[lastNode.selectIndex] ?? lastNode?.messages[0];
      if (live && lastMessage?.id === assistantMessageId && !generating.has(live.id)) {
        live.chatSuggestions = suggestions;
        live.updateAt = Date.now();
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch (suggestionError) {
      // Suggestions are auxiliary;正文生成状态不应受影响。
      reportError("provider", "warn", "会话建议生成失败", suggestionError, "suggestion_generation_failed");
    }
  }
}

/** pi 模型极限取值(P5 统计与压缩对齐):contextWindow 从 models.dev 查真实窗口
 *  (决定 pi 自动压缩阈值),max_tokens 沿用助手配置(与聊天引擎同源),没配则查
 *  models.dev 输出上限;都查不到时 model-bridge 用保守默认并在 max>窗口时收紧。 */
function piModelLimitsFor(provider: Provider, model: Model, assistant: Assistant) {
  return {
    contextWindow: lookupContextLimit(modelsDevCache, provider.type, model.modelId),
    maxTokens: assistant.maxTokens ?? lookupOutputLimit(modelsDevCache, provider.type, model.modelId),
  };
}

/** P7:选中路径上的消息序列 = 每节点取 selectIndex 处消息
 *  (conversations/index.ts selectedConversationMessages 同一口径)——本轮的
 *  prompt 用户消息(末 USER 节点)由调用方决定是否包含在内。 */
function selectedMessages(conversation: Conversation): Message[] {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
}

/** P7:conversation.piCompactions(DB 任意 JSON)→ 编码器契约。宽容校验:
 *  坏条目丢弃而不是整列作废(与列解析"损坏回 null"同哲学)。 */
function parsePiCompactions(raw: JsonValue[] | null | undefined): PiCompactionRecord[] {
  const records: PiCompactionRecord[] = [];
  for (const item of raw ?? []) {
    if (!isRecord(item)) continue;
    if (typeof item.cutMessageId !== "string" || typeof item.summary !== "string") continue;
    const record: PiCompactionRecord = {
      cutMessageId: item.cutMessageId,
      summary: item.summary,
      tokensBefore: typeof item.tokensBefore === "number" ? item.tokensBefore : 0,
    };
    if (typeof item.createdAt === "string") record.createdAt = item.createdAt;
    records.push(record);
  }
  return records;
}

/** P7:本轮压缩产物落 conversation.piCompactions。cutMessageId 为 null(pi 自动压缩
 *  的切点可能落在本轮 prompt 之后,而本轮消息尚未入库)按"外收拢"落当前尾消息
 *  id——只多保不少保,下一轮编码器按"切点在场"自校验生效。 */
function applyCapturedPiCompactions(conversation: Conversation, captured: CapturedPiCompaction[]): void {
  if (!captured.length) return;
  const tail = selectedMessages(conversation).at(-1);
  const records = parsePiCompactions(conversation.piCompactions);
  for (const item of captured) {
    const cutMessageId = item.cutMessageId ?? tail?.id;
    if (!cutMessageId) continue; // 无任何消息可挂靠(理论不可达):丢记录好过写错切点
    records.push({
      cutMessageId,
      summary: item.summary,
      tokensBefore: item.tokensBefore,
      createdAt: new Date().toISOString(),
    });
  }
  conversation.piCompactions = records as unknown as JsonValue[];
  markConversationRowDirty(conversation.id);
  scheduleThrottledConvFlush();
}

/** pi 引擎生成装配(P3 路由 + P4 资源统一 + P7 会话数据统一,方案 §4.2/§4.3/§4.7):
 *  - prompt 输入取末 USER 节点选中消息(P4 附件面:文档/OCR 文本化与聊天引擎同母本,
 *    图片走 pi 原生 images 通道);
 *  - 引擎上下文 = 编码器从选中路径历史(不含本轮 prompt 消息)确定性重建,压缩记录
 *    从 conversation.piCompactions 进同一灌注——重新生成/编辑重发/分支切换天然
 *    生效(UI 选中路径就是引擎记忆,所见即所记);
 *  - 工具面 = 七个工作区工具 + 通用工具/MCP 桥(P4),审批全部内化在工具 execute;
 *  - 资源面 = createPiSessionResources(技能白名单/AGENTS.md 边界过滤/人设+记忆冻结
 *    appendSystemPrompt/受控 settings)。 */
async function runPiWorkspaceGeneration(
  conversation: Conversation,
  assistantNode: MessageNode,
  runtime: WorkspaceRuntime,
  deps: { assistant: Assistant; providerItem: Provider; selectedModel: Model },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  const lastUserNode = [...conversation.messages]
    .reverse()
    .find((node) => (node.messages[node.selectIndex] ?? node.messages[0])?.role === "USER");
  const promptMessage = lastUserNode ? (lastUserNode.messages[lastUserNode.selectIndex] ?? lastUserNode.messages[0]) : null;
  const promptInput = promptMessage
    ? piPromptInputFromParts(promptMessage.parts, deps.selectedModel)
    : { text: "", images: [] };
  if (!promptInput.text && !promptInput.images.length) {
    // 无文本且无图片输入直接走失败分支给出人话。
    throw new Error("工作区会话缺少可发送的用户消息内容,无法驱动工作区引擎。");
  }
  const resources = await createPiSessionResources({
    conversation,
    assistant: deps.assistant,
    model: deps.selectedModel,
    cwd: runtime.cwd,
    root: runtime.root,
  });
  const history = selectedMessages(conversation).filter((msg) => msg.id !== promptMessage?.id);
  const result = await runPiGeneration({
    provider: deps.providerItem,
    model: deps.selectedModel,
    modelLimits: piModelLimitsFor(deps.providerItem, deps.selectedModel, deps.assistant),
    conversationId: conversation.id,
    cwd: runtime.cwd,
    history,
    compactions: parsePiCompactions(conversation.piCompactions),
    promptText: promptInput.text,
    images: promptInput.images,
    resources,
    tools: [
      ...createPiWorkspaceTools({ conversation, assistant: deps.assistant, sink }),
      ...createPiGeneralTools({ conversation, assistant: deps.assistant, sink, messageNodeId: assistantNode.id }),
    ],
    sink,
    signal,
  });
  applyCapturedPiCompactions(conversation, result.capturedCompactions);
  return result.text;
}

/** P5:工作区会话手动压缩改走 pi 原生 compaction;P7:压缩产物落
 *  conversation.piCompactions(下一轮生成由编码器把它重放进引擎上下文),UI 历史
 *  一字不动。返回 null = 非工作区会话/工作区不可用(缺根/未信任)——调用方回落
 *  UI 历史压缩(与生成路由的降级一致:聊天引擎从 UI 历史构建请求,压 UI 历史即
 *  压上下文)。压缩期间经 engine_status 直通状态条,finally 兜底清除(取消/失败
 *  不挂"压缩中")。 */
export async function compactPiWorkspaceConversation(
  conversation: Conversation,
  customInstructions: string,
  signal?: AbortSignal,
): Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter: number | null } | null> {
  const runtime = workspaceRuntimeForConversation(conversation);
  if (!runtime) return null;
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const resources = await createPiSessionResources({
    conversation,
    assistant,
    model: picked.model,
    cwd: runtime.cwd,
    root: runtime.root,
  });
  try {
    const result = await runPiCompaction({
      provider: picked.provider,
      model: picked.model,
      modelLimits: piModelLimitsFor(picked.provider, picked.model, assistant),
      conversationId: conversation.id,
      cwd: runtime.cwd,
      history: selectedMessages(conversation),
      compactions: parsePiCompactions(conversation.piCompactions),
      resources,
      customInstructions,
      signal,
      sink: (event) => {
        if (event.kind === "engine_status") broadcastEngineStatus(conversation.id, event.status);
      },
    });
    applyCapturedPiCompactions(conversation, [result.compaction]);
    return result;
  } finally {
    broadcastEngineStatus(conversation.id, { busy: false });
  }
}

/** 纯生成逻辑：驱动 Provider 流式/非流式调用，并通过 sink 发出生成事件。
 *  本函数不直接写 state.json、不直接广播 SSE、不直接落盘 SQLite——这些副作用由
 *  协调器 generateAnswer 统一处理。 */
async function runGeneration(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  deps: {
    assistant: Assistant;
    providerItem: Provider;
    selectedModel: Model;
    executeTool: ToolExecutor;
    /** P3 路由:工作区可用(三道闸通过)即 pi 引擎;null 走聊天引擎。 */
    piRuntime: WorkspaceRuntime | null;
  },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  // P3 路由切换(方案 §六):工作区会话由 pi 引擎跑循环,事件桥回灌同一 sink;
  // 工作区不可用(缺根/未信任)回落聊天引擎纯对话——openAiWorkspaceTools 同一判定
  // 返回空工具面,与 M4 降级语义一致。
  if (deps.piRuntime) {
    return runPiWorkspaceGeneration(conversation, assistantNode, deps.piRuntime, deps, sink, signal);
  }
  return callProviderStreaming(conversation, assistantMessage, assistantNode, {
    signal,
    sink,
    executeTool: deps.executeTool,
    // P1-4：generateAnswer 入口解析的 assistant/provider/model 贯穿本次生成，
    // callProviderStreaming 不再从可能已被替换的 state.settings 重新解析。
    snapshot: { assistant: deps.assistant, provider: deps.providerItem, model: deps.selectedModel },
  });
}

export async function generateAnswer(conversation: Conversation, regenerateAtNodeId?: string) {
  // R2-3:入口自带"先中止旧流"不变式。端点级守卫(send/edit/regenerate 的先 abort)挡不住
  // OCR 续体窗口:两条消息的续体先后异步触发本函数时,后者若直接 generating.set 会顶掉
  // 前者的 controller——前者成无主流,两路流式交错写同一节点(parts 交叉污染)、且无人能停。
  // 把端点级纪律下沉为编排器不变式:同会话已有登记流,先 abort 再接管(后到者胜,与端点
  // 语义一致)。completeConversationGeneration 按 controller 身份幂等,旧流收尾不会误删新登记。
  generating.get(conversation.id)?.abort();
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  // DB-first:整个生成期持有引用(与 finally 的 release 恰好配对一次;
  // completeConversationGeneration 有多处幂等调用,release 不能放那里)。
  // generating 条件本身也挡 sweep,refs 是纵深防御(abort 后 generating 先被清的窗口)。
  checkoutConversation(conversation.id);
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // P3:路由在入口一次判定并贯穿本次生成(与 P1-4 配置快照同理)——pi 引擎无
  // "暂停→续跑"模型,续跑/暂停分支只属于聊天引擎。
  const piRuntime = workspaceRuntimeForConversation(conversation);
  // 重新生成 ASSISTANT:调用方已在该 node 追加空占位 message 并把 selectIndex 指向它,
  // 直接复用,绕开 ensureAssistantGenerationNode(它会复用末尾 assistant 或新建 node,
  // 都不是"在指定 node 上新增分支")。find 不到时安全回退到默认逻辑。
  let assistantNode: MessageNode;
  if (regenerateAtNodeId) {
    const found = conversation.messages.find((n) => n.id === regenerateAtNodeId);
    assistantNode = found ?? ensureAssistantGenerationNode(conversation, picked.model.id);
  } else {
    assistantNode = ensureAssistantGenerationNode(conversation, picked.model.id);
  }
  const currentMessage = assistantNode.messages[assistantNode.selectIndex];
  activeGenerationMessages.set(conversation.id, currentMessage);
  // P1-3:四条出口路径(pending/done/aborted/failed)的共同收尾序列。差异只在 parts 与
  // finishedAt 处理,由 applyParts 注入。completeConversationGeneration 幂等,finally 兜底。
  const finalizeOutcome = (applyParts: () => void) => {
    // 批6复审 G2:接管守卫——被新流接管且新流复用同一消息对象时,旧流的收尾若继续执行,
    // 会对新流正在写的回答做 transforms/盖 finishedAt/写估算 usage,失败分支甚至把
    // "请求失败"文本和 model_call_error 注解追加进去。此时静默退出(消息已易主,由新流
    // 负责收尾);新流用的是新消息对象时,旧流仍照常收尾自己的消息,行为不变。
    const owner = generating.get(conversation.id);
    if (owner && owner !== controller && activeGenerationMessages.get(conversation.id) === currentMessage) return;
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    applyParts();
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  };
  const resumingApprovedTools = !piRuntime && hasResumableToolParts(currentMessage);
  currentMessage.finishedAt = null;
  // R7-2:重入生成(续写/重试复用同一消息对象)时清掉上一轮的失败标记,
  // 本轮成功后前端错误横幅不再残留;本轮再失败会在 catch 里重新落标记。
  // 异常数据容忍:annotations 缺失(手改/极老数据)不能让生成入口崩死整个会话——
  // 这里顺手自愈为数组,后续 push 同样安全(用户数据安全优先)。
  currentMessage.annotations = (currentMessage.annotations ?? []).filter(
    (item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === "model_call_error"),
  );
  // Allow createdAt to be re-stamped on the first content chunk of this generation pass —
  // supports regenerate, which reuses the same message object.
  streamStartedMessages.delete(currentMessage);
  if (!resumingApprovedTools) {
    // 专题11复审:非续跑的重入生成(重试等复用同一消息对象)清掉上一代 usage——
    // mergeTokenUsage 的“新值>0 才覆盖”会把上一代的 cachedTokens/completionTokens
    // 带进本轮统计。续跑(工具审批恢复)是同一请求的延续,保留。
    currentMessage.usage = null;
    // Show a loading placeholder immediately so the UI has visual feedback during the
    // upstream first-token wait. addStreamText / replaceLoadingReasoningWithTool will
    // strip this placeholder as soon as the first real delta arrives.
    setMessageLoading(currentMessage);
  }
  conversation.updateAt = Date.now();
  broadcastNodeUpdate(conversation, assistantNode);
  try {
    if (resumingApprovedTools) {
      await resumeApprovedToolParts(conversation, assistant, currentMessage, assistantNode, false, controller.signal);
    }
    // 工具执行闭包：把 server.ts 里的 executeToolCall 包装成 ToolExecutor 接口。
    // 这里保留对全局 state 的读写（如 saveToolBinaryContent），因为协调器仍然是唯一拥有
    // state 写权限的层；后续 Phase 会再把文件落盘拆到 files/ 模块。
    const executeTool: ToolExecutor = async (toolCall, context) => {
      // 注入生成级 signal（工作区工具据此取消，bash 连杀进程树）与部分输出回写
      // （bash 执行中把尾部输出写进 tool part，走现有 touchStream 合帧管线）。
      const raw = await executeToolCall(toolCall, assistant, {
        ...context,
        signal: controller.signal,
        onToolPartialOutput: (output) => applyEvent({ kind: "tool_result", toolCallId: toolCall.id, output }),
      });
      // ask_user / MCP 审批等 pending 状态直接作为单 output 载荷返回，让协调器走暂停路径。
      if (isRecord(raw) && "pending" in raw) {
        return { output: [raw as unknown as ToolPendingOutput] };
      }
      const normalized = await toolResultToParts(raw);
      const output = await realizeToolResult(normalized);
      return { output };
    };
    // P2(pi 引擎):内联 applyEvent 抽取为共享应用器(conversations/generation-apply.ts,
    // 逐字搬迁行为零变)——聊天引擎与 pi 事件桥共用同一份"事件→parts"写入字典。
    const applyEvent = createGenerationEventApplier({ conversation, node: assistantNode, message: currentMessage });
    const sink: GenerationEventSink = (event) => {
      // P5:引擎瞬态状态(压缩中/自动重试)不落库不产 part,直通会话 SSE 状态条;
      // 其余事件照走应用器。generateAnswer finally 兜底 busy:false,中途 abort 不挂条。
      if (event.kind === "engine_status") {
        broadcastEngineStatus(conversation.id, event.status);
        return;
      }
      applyEvent(event);
    };
    const content = await runGeneration(
      conversation,
      currentMessage,
      assistantNode,
      { assistant, providerItem: picked.provider, selectedModel: picked.model, executeTool, piRuntime },
      sink,
      controller.signal,
    );
    if (controller.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    if (!piRuntime && hasPendingToolApproval(currentMessage)) {
      // 注:hasPendingToolApproval 判定在 applyOutputTransforms 之前与旧实现一致——
      // 旧实现先 transform 再判定,但 transform 只改 text/reasoning parts,不触碰 tool
      // parts 的 approvalState,判定结果不受影响;两分支的 transform 都由 finalize 统一做。
      finalizeOutcome(() => {
        currentMessage.finishedAt = null;
      });
      return;
    }
    finalizeOutcome(() => {
      if (currentMessage.parts.length === 0) {
        finishMessage(currentMessage, [{ type: "text", text: content }]);
      } else {
        const hasText = textFromParts(currentMessage.parts).trim().length > 0;
        if (!hasText && content && content !== "(empty response)") {
          appendTextPart(currentMessage, content);
        }
        currentMessage.finishedAt = new Date().toISOString();
      }
    });
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, currentMessage.id);
  } catch (err) {
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    // 批6复审 G3:abort 意图支配错误分类——部分 fetch 实现/上游在 abort 时抛的是普通
    // 网络错误而非 AbortError,若走失败分支会给用户主动停止的回答追加"请求失败"+错误
    // 注解并弹全局错误。只要本流已被要求中止,一律按中止收尾。
    if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      finalizeOutcome(() => {
        // 批6复审 G4:中止若发生在首个 delta 之前,loading 占位没人摘(正常路径由首个
        // delta 摘,stop 端点手工摘,但删会话/接管等 abort 路径不经过 stop 端点),
        // 前端"打字点"会永久残留在已完结消息上。与 stop 端点的手工摘除对齐。
        currentMessage.parts = currentMessage.parts.filter((part) => !(isRecord(part) && part.type === "loading"));
        currentMessage.finishedAt = new Date().toISOString();
      });
      return;
    }
    // 匿名遥测:只记"发生了一次 provider 失败",不采集错误内容/模型/服务商。
    bumpAnalyticsErrCount();
    const rawContent = err instanceof Error ? err.message : String(err);
    const proxyHint = classifyProxyError(err, state.settings.proxyConfig);
    const failureText = proxyHint ?? classifyContextOverflowError(err) ?? classifyRateLimitError(err) ?? `请求失败：${rawContent}`;
    // P2-1(N-7 归宿):失败文本除了写进会话消息(仅会话 SSE 可见),还上报全局通道——
    // 用户不在该会话页时也能收到通知(批2 接前端 toast)。
    reportError("provider", "error", failureText, err);
    finalizeOutcome(() => {
      if (currentMessage.parts.length === 0) {
        finishMessage(currentMessage, [{ type: "text", text: failureText }]);
      } else {
        appendTextPart(currentMessage, `\n\n${failureText}`);
        currentMessage.finishedAt = new Date().toISOString();
      }
      // R7-2:结构化错误标记——前端"打开模型设置"横幅由它驱动,
      // 不再对正文做关键词正则(讨论 HTTP 状态码/超时的正常回答不误报)。
      currentMessage.annotations.push({ type: "model_call_error", message: failureText });
    });
  } finally {
    releaseConversation(conversation.id);
    completeConversationGeneration(conversation.id, controller);
    // P5:生成终局兜底清引擎状态条——压缩/重试进行中 abort/失败时,end 事件可能永远
    // 不来,不清会挂死"压缩中"。幂等,聊天引擎路径广播空集合无副作用。
    if (piRuntime) broadcastEngineStatus(conversation.id, { busy: false });
    if (!conversationStillExists(conversation.id)) return;
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  }
}

export function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.messages[last.selectIndex]?.role === "ASSISTANT") {
    const msg = last.messages[last.selectIndex];
    msg.modelId = modelId;
    return last;
  }
  const assistantNode: MessageNode = {
    id: id(),
    messages: [message("ASSISTANT", [], modelId)],
    selectIndex: 0,
  };
  conversation.messages.push(assistantNode);
  // 新节点立即标脏:节点创建到第一个 chunk 之间存在窗口,若此窗口内导出/统计(DB-first
  // 读活库)或进程崩溃,未标脏的节点不在任何落库计划里。标脏后 flushConvDirtyNow 可见,
  // 与旧"读内存必含该节点"行为对齐。
  markMessageNodeDirty(conversation.id, assistantNode.id);
  scheduleThrottledConvFlush();
  return assistantNode;
}

// Tolerate both layouts: when run via `bun run server.ts`, argv[0..1] are bun + script;
// when run as a `bun build --compile` exe, argv[0] is the exe itself. `slice(1)` strips
// the leading process binary in both cases, leaving just user flags.
