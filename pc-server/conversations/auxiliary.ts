// conversations/auxiliary.ts — 辅助生成（标题/建议/翻译/提示词优化/OCR/会话压缩）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。

import type { Assistant, AuxiliaryTextOptions, Conversation, Message, MessagePart, Model } from "../foundation/types";
import { applyPlaceholders, id, isRecord, localeDisplayName, message, textFromParts, uniqueStrings } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { broadcastConversation, broadcastEngineStatus } from "../api/sse";
import { DEFAULT_AUTO_MODEL_ID, applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { endpointFor } from "../model-providers/checks";
import { DEFAULT_OUTPUT_TOKENS, openAiMaxTokensField, reasoningLevelNormalized } from "../model-providers/request-dialect";
import {
  auxiliaryReasoningPayloadForProvider,
  claudeThinkingPayload,
  dataUrlForMessageUrl,
  hostOfProvider,
  isModelAllowTemperature,
  parseDataUrl,
  supportsAbility,
  supportsInputModality,
} from "../inference-engine/message-builder";
import {
  completionMessageText,
  fetchClaudeAuxiliaryStream,
  fetchGoogleAuxiliaryStream,
  fetchOpenAiAuxiliaryStream,
  fetchText,
} from "../inference-engine/providers";
import {
  DEFAULT_COMPRESS_PROMPT,
  DEFAULT_OCR_PROMPT,
  DEFAULT_SUGGESTION_PROMPT,
  DEFAULT_TITLE_PROMPT,
  SUGGESTION_CHARACTER_LIMIT,
  TITLE_CHARACTER_LIMIT,
} from "../app-config/prompts";
import { compressing } from "./generation-state";
import { getConversation, persistConversation, selectedConversationMessages } from "./index";
import { findAssistant, summaryAsText } from "./helpers";
import { agentSummaryAsText, buildAgentCompactionContext, extractAgentActivity } from "../workspace/compaction";

export function cleanAuxiliaryText(text: string, fallback = "") {
  const cleaned = text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  if (!cleaned || cleaned === "(empty response)") {
    if (fallback) return fallback;
    throw new Error("Auxiliary model returned empty response");
  }
  return cleaned;
}

function firstAuxiliaryLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function limitAuxiliaryText(text: string, limit: number) {
  return Array.from(text).slice(0, limit).join("");
}

export async function generateTitleForConversation(conversation: Conversation) {
  const summary = conversationSummary(conversation, 4).trim();
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const content = summary || firstText;
  if (!content) return "New Conversation";
  const prompt = applyPlaceholders(state.settings.titlePrompt || DEFAULT_TITLE_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-4).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.titleModelId, prompt, "title", {
    reasoningLevel: "off",
  });
  return limitAuxiliaryText(
    firstAuxiliaryLine(cleanAuxiliaryText(text, limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation")),
    TITLE_CHARACTER_LIMIT,
  ) || "New Conversation";
}

export function shouldAutoGenerateTitle(conversation: Conversation) {
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const title = String(conversation.title ?? "").trim();
  if (!title || title === "New Conversation") return true;
  if (firstText && title === limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT)) return true;
  return false;
}

function conversationSummary(conversation: Conversation, takeLast = 8) {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .slice(-takeLast)
    .map((msg) => summaryAsText(msg))
    .filter((line) => line.trim().length > 6)
    .join("\n\n");
}

export function isQwenMtModel(modelId: string) {
  const normalized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.includes("qwen") && tokens.includes("mt");
}

export function englishLanguageName(locale: string) {
  const language = locale.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(language) || displayNames.of(language.split(/[-_]/)[0]) || language;
  } catch {
    return language.split(/[-_]/)[0] || language;
  }
}

export async function fetchAuxiliaryText(modelId: string, prompt: string, kind: string, options: AuxiliaryTextOptions = {}) {
  const picked = findModel(modelId || state.settings.chatModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const maxTokens = options.maxTokens ?? null;
  const reasoningLevel = options.reasoningLevel ?? null;
  const stream = options.stream === true;
  const pushDelta = (text: string) => {
    if (text) options.onDelta?.(text);
  };
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: options.temperature ?? null,
    topP: null,
    maxTokens,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
    customBodies: options.customBody
      ? Object.entries(options.customBody).map(([key, value]) => ({ key, value }))
      : [],
  } as Assistant;
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;
  if (providerItem.type === "google") {
    // issue10:Gemini 鉴权统一走 x-goog-api-key 头,URL 不再带 ?key=(中转网关只认 header)。
    headers["x-goog-api-key"] = providerItem.apiKey;
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
      },
    };
    if (stream) {
      const streamEndpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:streamGenerateContent`;
      try {
        return cleanAuxiliaryText(await fetchGoogleAuxiliaryStream(streamEndpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        // Fall back to non-streaming auxiliary calls; some compatible gateways do not expose Gemini streaming.
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text);
  }
  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: maxTokens ?? DEFAULT_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(options.temperature != null && (!reasoningLevel || !reasoningEnabled(reasoningLevel)) ? { temperature: options.temperature } : {}),
      // 与主路径一致：thinking + output_config，DeepSeek 走 Claude 格式时 display:"raw"
      ...(reasoningLevel ? claudeThinkingPayload(modelItem, reasoningLevel) : {}),
    };
    if (stream) {
      try {
        return cleanAuxiliaryText(await fetchClaudeAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        body.stream = false;
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n"));
  }
  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{ role: "user", content: prompt }],
        stream,
        store: false,
        ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}),
        ...(reasoningLevel && supportsAbility(modelItem, "REASONING")
          ? { reasoning: { summary: "auto", ...(reasoningLevelNormalized(reasoningLevel) !== "auto" ? { effort: reasoningLevelNormalized(reasoningLevel) === "off" ? "none" : reasoningLevelNormalized(reasoningLevel) } : {}) } }
          : {}),
      }
    : {
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        stream,
        // 上限字段名走统一请求方言（model-providers/request-dialect），与主生成路径一致。
        ...(maxTokens != null ? { [openAiMaxTokensField(hostOfProvider(providerItem))]: maxTokens } : {}),
        ...(options.temperature != null && isModelAllowTemperature(modelItem) ? { temperature: options.temperature } : {}),
        ...(options.topP != null && isModelAllowTemperature(modelItem) ? { top_p: options.topP } : {}),
        ...auxiliaryReasoningPayloadForProvider(providerItem, modelItem, reasoningLevel),
      };
  if (stream) {
    try {
      const text = await fetchOpenAiAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta);
      if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
      return text;
    } catch {
      body.stream = false;
    }
  }
  const text = await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText);
  if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
  return text;
}

function reasoningEnabled(level: string | null | undefined) {
  return reasoningLevelNormalized(level) !== "off";
}

export function modelExists(modelId: string | null | undefined) {
  if (!modelId) return false;
  if (modelId === DEFAULT_AUTO_MODEL_ID || modelId === "auto") return true;
  return state.settings.providers.some((providerItem) =>
    providerItem.models.some((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId)
  );
}

async function fetchAuxiliaryOcrText(imageUrl: string) {
  if (!modelExists(state.settings.ocrModelId)) return "";
  const picked = findModel(state.settings.ocrModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: 0,
    topP: null,
    maxTokens: 2048,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as Assistant;
  const prompt = state.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  const dataUrl = dataUrlForMessageUrl(imageUrl);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    headers["x-goog-api-key"] = providerItem.apiKey;
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text));
  }

  if (providerItem.type === "claude") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n")));
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        max_output_tokens: 2048,
      }
    : {
        model: selectedModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        // 上限字段名走统一请求方言（o 系官方口同样具备视觉能力，恒发 max_tokens 会 400）。
        [openAiMaxTokensField(hostOfProvider(providerItem))]: 2048,
        temperature: isModelAllowTemperature(modelItem) ? 0 : undefined,
      };
  return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText));
}

function shouldOcrForModel(modelItem: Model) {
  return !supportsInputModality(modelItem, "IMAGE") && modelExists(state.settings.ocrModelId);
}

export async function attachOcrToImageParts(parts: MessagePart[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  const next = [...parts];
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "image") continue;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) continue;
    const url = String(part.url ?? "");
    if (!url) continue;
    try {
      const ocrText = await fetchAuxiliaryOcrText(url);
      if (ocrText) {
        next[index] = { ...part, metadata: { ...metadata, ocrText, ocrStatus: "done" } };
      }
    } catch (err) {
      next[index] = {
        ...part,
        metadata: {
          ...metadata,
          ocrStatus: "failed",
          ocrError: err instanceof Error ? err.message : String(err),
        },
      };
      console.warn("OCR failed:", err);
    }
  }
  return next;
}

export function markOcrPendingParts(parts: MessagePart[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "image") return part;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) return part;
    return { ...part, metadata: { ...metadata, ocrStatus: "pending" } };
  });
}

export async function generateSuggestionsForConversation(conversation: Conversation) {
  const content = conversationSummary(conversation, 8);
  if (!content) return [];
  const prompt = applyPlaceholders(state.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-8).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.suggestionModelId, prompt, "suggestion", {
    reasoningLevel: "off",
  });
  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
      .filter(Boolean)
      .map((line) => limitAuxiliaryText(line, SUGGESTION_CHARACTER_LIMIT))
      .filter(Boolean),
  ).slice(0, 10);
}

/** 压缩发生点标记(两模式共享):压缩完成时打在"当时的最新一条消息"上,前端据此在该
 *  消息下方渲染"上下文已压缩"分割线——锚定用户发起压缩的位置。刻意不锚定切点/摘要
 *  的技术形态(pi 保留窗口的切点在时间线中段,线画在那里用户会疑惑"我在底部发的
 *  /compact,线怎么跑上面去了")。幂等:同一条消息不重复打。 */
export function markCompactionBoundary(conversation: Conversation): void {
  const tail = selectedConversationMessages(conversation).at(-1);
  if (!tail) return;
  tail.annotations ??= [];
  if (tail.annotations.some((item) => isRecord(item) && item.type === "compaction_boundary")) return;
  tail.annotations.push({ type: "compaction_boundary" });
}

export async function compressConversation(conversation: Conversation, additionalPrompt = "", targetTokens = 2000, keepRecentMessages = 32, signal?: AbortSignal) {
  const allMessages = selectedConversationMessages(conversation);
  if (allMessages.length === 0) throw new Error("当前会话没有可压缩的消息");

  // 内测反馈(310K 会话 /compact 报"消息数量不足"):按条数保留的语义对"少而长"的会话
  // 不成立——20 条超长消息的会话 token 巨大,却因条数 ≤ 默认保留 32 条被整体划进保留区,
  // 直接拒绝。压缩的目的是省上下文,"保留最近 N 条"是手段不是目的:条数不足时自动降级
  // 为保留一半(至少压掉一半旧消息),恒可压。单条消息 floor(1/2)=0 → 全压成摘要,同样成立。
  let effectiveKeepRecent = keepRecentMessages;
  if (effectiveKeepRecent > 0 && allMessages.length <= effectiveKeepRecent) {
    effectiveKeepRecent = Math.floor(allMessages.length / 2);
  }

  let messagesToCompress: Message[];
  let messagesToKeep: Message[];
  if (effectiveKeepRecent > 0) {
    messagesToCompress = allMessages.slice(0, -effectiveKeepRecent);
    messagesToKeep = allMessages.slice(-effectiveKeepRecent);
  } else {
    messagesToCompress = allMessages;
    messagesToKeep = [];
  }

  const splitMessages = (messages: Message[]): Message[][] => {
    if (messages.length <= 256) return [messages];
    const mid = Math.floor(messages.length / 2);
    return [...splitMessages(messages.slice(0, mid)), ...splitMessages(messages.slice(mid))];
  };

  // Agent 分化(§9.8):入口/管线/提示词同一套,仅输入构建按会话类型变——工具 part 折为
  // 摘要行进压缩输入,工作区活动清单经 {additional_context} 结构化注入(pi CompactionDetails
  // 思想)。chat 会话(workspaceId 空)走原路径,逐字节不变。
  const isAgent = Boolean(conversation.workspaceId);
  const summarize = isAgent ? (msg: Message) => agentSummaryAsText(msg, summaryAsText(msg)) : summaryAsText;
  const chunks = splitMessages(messagesToCompress);
  const summaries: string[] = [];
  // 失败/取消的 UI 收尾无需在此处理:进度在 engine-status 帧里(compress 端点 finally
  // 统一广播 busy:false),不再有落在会话对象上的瞬态标签需要清理。
  for (const chunk of chunks) {
    // R7-4:每个分块前查取消——用户中途取消不再烧后续分块的 LLM 轮次。
    if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
    // 分块进度走 engine-status 帧(状态条统一渲染"正在压缩上下文 (n/m) · 已处理 xx秒")。
    // 原实现借 chatSuggestions 建议条展示进度文本——挪用了建议区的语义位,且文案
    // 无法 i18n;进度本就是引擎状态的一部分,并入 engine-status 后该 hack 退役。
    // startedAt 从 compressing 注册表回读(compress 端点开始时写入),进度帧不重置计时。
    broadcastEngineStatus(conversation.id, {
      busy: true,
      phase: "compacting",
      progress: { current: summaries.length + 1, total: chunks.length },
      ...(compressing.has(conversation.id) ? { startedAt: compressing.get(conversation.id) } : {}),
    });
    const contextSections = [
      additionalPrompt.trim() ? `Additional instructions from user: ${additionalPrompt.trim()}` : "",
      isAgent ? buildAgentCompactionContext(extractAgentActivity(chunk)) : "",
    ].filter(Boolean);
    const prompt = applyPlaceholders(state.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT, {
      content: chunk.map(summarize).join("\n\n"),
      target_tokens: String(targetTokens),
      additional_context: contextSections.join("\n\n"),
      locale: localeDisplayName(),
    });
    summaries.push(cleanAuxiliaryText(await fetchAuxiliaryText(state.settings.compressModelId || state.settings.chatModelId, prompt, "compression", {
      stream: true,
    })));
  }
  // R7-4:落库前最后一道闸——取消后 LLM 结果作废,绝不改写会话(压缩是破坏性替换,
  // 取消语义必须硬保证)。
  if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
  // 批6复审 G1:会话在压缩期间被删除/被导入替换时结果同样作废——下方 persistConversation
  // 是无条件 upsert,会把已删会话复活成"只剩摘要"的僵尸。
  if (getConversation(conversation.id) !== conversation) throw new Error("会话已被删除,压缩结果作废");

  conversation.messages = [
    ...summaries.filter(Boolean).map((summary) => ({ id: id(), messages: [message("USER", [{ type: "text", text: summary }])], selectIndex: 0 })),
    ...messagesToKeep.map((msg) => ({ id: id(), messages: [JSON.parse(JSON.stringify(msg))], selectIndex: 0 })),
  ];
  markCompactionBoundary(conversation);
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  return summaries;
}
