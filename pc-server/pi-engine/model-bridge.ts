// pi-engine/model-bridge.ts — 我们的 provider/模型配置 → pi 模型运行时（方案 §3.5）。
//
// 原则：模型与密钥只有一个家（state.json）；pi 是无状态引擎，每次会话由我们注满。
// 注入走 ModelRuntime 官方内存注册面 registerProvider（为 extension 设计的公开 API），
// pi 侧的 models.json / auth.json 永不存在（modelsPath: null 走内存 store）。
//
// 契约：传入的 provider 必须是"生效 provider"（findModel 已展开 providerOverwrite 的输出），
// 与聊天引擎同源同口径——工作区会话用的模型 = 设置页配的那一个，逐字一致。
import type { Api, KnownApi, Model as PiModel } from "../../pi/packages/ai/src/types.ts";
import { AuthStorage } from "../../pi/packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../../pi/packages/coding-agent/src/core/provider-composer.ts";
import type { Model, Provider } from "../foundation/types";
import { applyModelRequestHeaders } from "../model-providers";

export interface PiModelMapping {
  /** 我们的 provider UUID 直接作 pi providerId：与 pi 内建 id 永不冲突，注册面完全由我们权威。 */
  providerId: string;
  /** 上游模型 id（进请求体的 model 字段）。 */
  modelId: string;
  config: ProviderConfigInput;
}

export type PiMappingResult = { ok: true; mapping: PiModelMapping } | { ok: false; reason: string };

// 我们不做成本核算（pi 用 cost 算展示成本，全 0 = 不产生虚假数字）。
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// 我们的模型配置不含上下文窗口/输出上限（安卓同构无此字段），给 pi 保守通用默认。
// 影响面：pi 的自动压缩阈值与请求 max_tokens；P5 统计对齐时若需要再精化为按模型推断。
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 协议映射（方案 §3.5 映射表）。返回 null = 无法映射，走诚实过滤面。 */
export function piApiFor(provider: Provider): KnownApi | null {
  if (provider.type === "claude") return "anthropic-messages";
  if (provider.type === "google") return "google-generative-ai";
  if (provider.type === "openai") {
    if (provider.useResponseApi) return "openai-responses";
    // pi 的 OpenAI 客户端（官方 SDK）固定拼 /chat/completions，自定义补全路径无法透传。
    const path = provider.chatCompletionsPath || "/chat/completions";
    return path === "/chat/completions" ? "openai-completions" : null;
  }
  return null;
}

function piBaseUrlFor(provider: Provider, api: KnownApi): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  // 口径差：我们的 claude baseUrl 含 /v1（端点 = base + /messages）；pi 的 anthropic SDK
  // 自己拼 /v1/messages，故剥掉尾部 /v1。openai（SDK 拼 /chat/completions 或 /responses）
  // 与 google（两侧 base 均含 /v1beta）约定一致，逐字透传。
  if (api === "anthropic-messages") return base.replace(/\/v1$/, "");
  return base;
}

/** 映射不到时给用户看的原因（模型选择器过滤面与错误提示共用，方案"诚实披露，不硬塞"）。 */
export function mapProviderModelToPi(provider: Provider, model: Model): PiMappingResult {
  const api = piApiFor(provider);
  if (!api) {
    return {
      ok: false,
      reason:
        provider.type === "openai"
          ? `自定义补全路径 ${provider.chatCompletionsPath} 无法映射到 pi 引擎（其 OpenAI 客户端固定使用 /chat/completions）`
          : `provider 类型 ${provider.type} 无法映射到 pi 引擎`,
    };
  }
  if (!model.modelId) return { ok: false, reason: "模型缺少 modelId，无法映射到 pi 引擎" };

  // 复用聊天引擎的请求头语义（模型级自定义头 + 主机特例），保证两个引擎行为逐字一致。
  const headers: Record<string, string> = {};
  applyModelRequestHeaders(headers, provider, model);

  const config: ProviderConfigInput = {
    name: provider.name,
    baseUrl: piBaseUrlFor(provider, api),
    // pi 组合器要求必须有鉴权方式（composeModelProvider 无 key 即抛）；无密钥的本地端点
    // （如 ollama）用占位符——等价我们聊天引擎发 `Bearer ` 空串，服务端同样忽略。
    apiKey: provider.apiKey || "unused",
    api,
    ...(Object.keys(headers).length ? { headers } : {}),
    models: [
      {
        id: model.modelId,
        name: model.displayName || model.modelId,
        reasoning: model.abilities.includes("REASONING"),
        input: model.inputModalities.includes("IMAGE") ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      },
    ],
  };
  return { ok: true, mapping: { providerId: provider.id, modelId: model.modelId, config } };
}

/** 为一次工作区会话构造 pi 模型运行时：内存注册单 provider 单模型，零落盘。 */
export async function createPiModelRuntime(
  mapping: PiModelMapping,
): Promise<{ runtime: ModelRuntime; model: PiModel<Api> }> {
  const runtime = await ModelRuntime.create({
    // 密钥经 ProviderConfigInput 注入,凭据存储用内存实现——pi 的文件后端会急切创建
    // auth.json(空 {}),传 authPath 都会破"零落盘";modelsPath: null 同理走内存 store。
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
  });
  runtime.registerProvider(mapping.providerId, mapping.config);
  const model = runtime.getModel(mapping.providerId, mapping.modelId);
  if (!model) {
    throw new Error(`pi 运行时未返回已注册模型 ${mapping.providerId}/${mapping.modelId}`);
  }
  return { runtime, model };
}
