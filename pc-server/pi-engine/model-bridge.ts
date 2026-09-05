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
import { hostOfProvider } from "../inference-engine/message-builder";
import { applyModelRequestHeaders } from "../model-providers";
import {
  budgetTokensFor,
  DEFAULT_OUTPUT_TOKENS,
  EFFORT_LOW_HIGH_MAX_BY_LEVEL,
  isKimiK3Model,
  OPENAI_DEVELOPER_ROLE_ALLOWED,
  openAiMaxTokensField,
  openAiThinkingSwitchProtocol,
  reasoningLevelNormalized,
} from "../model-providers/request-dialect";

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
// 我们的模型配置不含上下文窗口/输出上限（安卓同构无此字段）。P5：调用方经 limits 传
// models.dev 真实值（影响 pi 自动压缩阈值 contextWindow-reserveTokens 与请求 max_tokens），
// 查不到时用保守通用默认——128k 窗口宁可让大窗口模型早压缩，也不给小窗口模型虚报。
const DEFAULT_CONTEXT_WINDOW = 128_000;
// 输出上限兜底与聊天引擎同源(DEFAULT_OUTPUT_TOKENS,方言单源);目录命中时用真实上限。

/** 调用方可注入的模型极限(orchestrator 从 models.dev/助手配置取值,本模块保持纯映射)。 */
export interface PiModelLimits {
  contextWindow?: number | null;
  maxTokens?: number | null;
}

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
  // claude 归一化(A,两引擎同款):剥尾部 /v1——pi 的 anthropic SDK 自己拼 /v1/messages;
  // 聊天引擎 endpointFor 同规则(剥 /v1 再拼 /v1/messages),用户带不带 /v1 两引擎皆通。
  // openai(SDK 拼 /chat/completions 或 /responses)与 google(两侧 base 均含 /v1beta)
  // 约定一致,逐字透传。
  if (api === "anthropic-messages") return base.replace(/\/v1$/, "");
  return base;
}

/** pi compat 显式覆盖 = 统一请求方言的 pi 侧翻译（T4.6 内测缺陷修复 → T4.7 方言单源化）。
 *
 *  背景：pi 的 detectCompat 以西方厂商白名单自动探测，未知 baseUrl（国内生态：
 *  DashScope/火山方舟/SiliconFlow/各类中转）一律按「官方 OpenAI 能力」假设——推理
 *  模型系统消息发 "developer"（第三方 400 拒收）、上限字段发 max_completion_tokens
 *  （第三方静默忽略 → 上限失效）。方言事实与依据集中在 model-providers/request-dialect
 *  （聊天引擎构建体消费同一模块），此处只做 pi compat 旋钮的逐字段翻译：
 *
 *  - supportsDeveloperRole ← OPENAI_DEVELOPER_ROLE_ALLOWED（completions/responses 同名同义）。
 *  - maxTokensField ← openAiMaxTokensField(host)（仅 completions；responses 原生
 *    max_output_tokens 无此字段。官方主机显式 max_completion_tokens 与 pi 自动探测
 *    同值，显式写死 = 口径由方言决定，不依赖 pi 探测碰巧一致）。
 *  - 思考「开关」（enable_thinking/thinking.type/thinking_mode 等厂商字段）入方言：
 *    协议种类由 openAiThinkingSwitchProtocol 声明（host 级事实＋SiliconFlow 白名单），
 *    本层经 piThinkingOverridesFor 译成 pi 的 thinkingFormat/supportsReasoningEffort
 *    覆盖——按 host 逐厂商覆盖，不会误伤 OpenRouter 等兜底主机（见该函数头注）。
 *  - 思考「档位值域」同方言（Kimi K3 官方移除 thinking、reasoning_effort 仅认
 *    low/high/max，非法值 400；DeepSeek 官方 effort 同值域）：经 pi 原生
 *    thinkingLevelMap 喂入 EFFORT_LOW_HIGH_MAX_BY_LEVEL——与聊天引擎同一张收拢表。
 *  - 思考档位已接通（runner 传 WORKSPACE_THINKING_LEVEL，非思考模型 pi 自动收拢回
 *    off）。采样设置接通那天的既定口径（勿另起判定）：温度/top_p 过方言
 *    isSamplingLockedModel；claude 老模型预算经 pi 的 options.thinkingBudgets 通道
 *    喂聊天引擎 budgetTokensFor 同款表（届时提升方言）；google 同类。历史思考回传无需接线——pi 对称回传（收到什么字段回传什么字段），
 *    K3/DeepSeek 官方硬性要求已天然满足，与聊天引擎 includeHistoryReasoning 默认
 *    行为一致（工作区不支持用户关闭回传：agent 工具循环下思考连续性即正确性）。
 *  - claude/google 协议无以上概念，不设（各自 compat 类型契约不同）。 */
function piCompatOverridesFor(provider: Provider, api: KnownApi) {
  if (api === "openai-responses") return { supportsDeveloperRole: OPENAI_DEVELOPER_ROLE_ALLOWED };
  if (api !== "openai-completions") return undefined;
  return {
    supportsDeveloperRole: OPENAI_DEVELOPER_ROLE_ALLOWED,
    maxTokensField: openAiMaxTokensField(hostOfProvider(provider)),
    // 聊天引擎从不发 store 字段(官方 chat completions 默认即 store:false,无隐私退化;
    // 第三方严格端点对未知字段有拒收风险)——压制 pi 默认的 store:false 输出,两引擎对齐。
    supportsStore: false,
  };
}

/** pi 受控 settings 的思考预算表——聊天引擎预算表(方言 THINKING_BUDGET_BY_LEVEL,
 *  安卓对齐)的 pi 投影。推导而非抄写:方言表改数值,此处自动跟随。消费面:Google 2.x
 *  预算通道(gemini 2.5 flash 类,此前 pi 默认表 medium=8192 vs 聊天 2000,同档位预算
 *  差 4 倍)。xhigh/max 独立键依赖 vendor 扩键补丁(pi ThinkingBudgets 原生仅四键,
 *  已在 pi/packages/ai 打 [RIKKAHUB PATCH: budget-xhigh-max],全档位与聊天引擎逐值
 *  对齐:xhigh 16000/max 32000);minimal 取聊天兜底值 8000(安卓无 minimal 档,兜底
 *  分支同值)。 */
export const PI_THINKING_BUDGETS: Readonly<Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", number>> = {
  minimal: budgetTokensFor("minimal"),
  low: budgetTokensFor("low"),
  medium: budgetTokensFor("medium"),
  high: budgetTokensFor("high"),
  xhigh: budgetTokensFor("xhigh"),
  max: budgetTokensFor("max"),
};

/** Anthropic 格式思考方言(镜像聊天引擎 claudeThinkingPayload——安卓对齐的 adaptive
 *  方言:全部思考模型 thinking:{type:"adaptive"}+output_config.effort,档位原样透传):
 *  pi 默认走老预算方言(thinking:{type:"enabled"}+budget_tokens,xhigh/max 结构性钳
 *  high;用户日志实证同一 K3 端点 chat=effort"max"/pi=budget 8192,形状与值双分歧)。
 *  forceAdaptiveThinking 切 effort 通道;thinkingLevelMap 六档同名登记(pi
 *  mapThinkingLevelToEffort 有映射即原样,缺省会把 xhigh/max 钳 high);off 不标
 *  null——off 时 pi 发 thinking:{type:"disabled"},与聊天引擎 off 分支逐字一致。
 *  已知观感差异:聊天对 DeepSeek 系 display:"raw"(原始思维链),pi 无 thinkingDisplay
 *  透传通道,恒 summarized——仅展示形态,不影响思考行为。 */
function piAnthropicThinkingOverrides(): { compat: Record<string, unknown>; thinkingLevelMap: Record<string, string> } {
  return {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  };
}

/** pi 会话思考档位(pi 值域 off/minimal/low/medium/high/xhigh/max,sdk 按模型支持集
 *  就近钳制,非思考模型自动收拢 off)。档位来源=助手设置 reasoningLevel(与聊天引擎
 *  同源同归一化):
 *  - off/none→off:openai 生态不发强度字段(thinking-type 厂商发 disabled);anthropic
 *    尊重 thinkingLevelMap.off=null(K3 思考关不掉→不发字段),与聊天引擎语义一致。
 *  - 六档→同名直传:openai 生态经 thinkingLevelMap 收拢(K3/DeepSeek 三档表)或原样
 *    effort;anthropic 走 adaptive+effort 方言(见 piAnthropicThinkingOverrides);
 *    google 走预算通道,查受控 settings 注入的 PI_THINKING_BUDGETS(vendor 扩键后
 *    六档精确命中,与聊天引擎逐值一致)。
 *  - auto/未知→medium:pi 无"不发字段用厂商默认"的 auto 语义,取编码 agent 生态通行
 *    默认(与接线前的固定档位一致,未显式选档的用户零行为变化)。 */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function piThinkingLevelFor(reasoningLevel: string | null | undefined): PiThinkingLevel {
  const normalized = reasoningLevelNormalized(reasoningLevel);
  return (PI_THINKING_LEVELS as readonly string[]).includes(normalized) ? (normalized as PiThinkingLevel) : "medium";
}

/** 厂商思考开关的 pi 侧翻译——方言 openAiThinkingSwitchProtocol 的消费者（全面审查 7）。
 *
 *  修复的故障面：此前工作区对智谱/DeepSeek（pi 白名单探测 zai/deepseek format）在
 *  未接档位时强制发 thinking:{type:"disabled"} 关思考（agent 推理能力被残废）；对
 *  DashScope/火山/SiliconFlow（pi 白名单外）不发任何开关字段，用户无从控制。
 *  原则同 maxTokensField：显式覆盖＝口径由方言决定，不依赖 pi 探测碰巧一致（对
 *  智谱/DeepSeek 的覆盖与 pi 探测同值，幂等锁定）。
 *
 *  已知降级（诚实记录）：DashScope thinking_budget 预算精调、K2.6 keep:"all" 保留式
 *  思考——pi 无对应旋钮，开关生效但附加参数不发；书生 thinking_mode pi 无法表达，
 *  压制思考字段走模型默认。NVIDIA：pi 白名单显式关 effort（作者实证，值域特殊），
 *  预置无此厂商，尊重探测不覆盖。 */
function piThinkingOverridesFor(
  provider: Provider,
  model: Model,
): { compat?: Record<string, unknown>; thinkingLevelMap?: Record<string, string | null> } | undefined {
  const host = hostOfProvider(provider);
  if (host === "integrate.api.nvidia.com") return undefined;
  if (isKimiK3Model(model.modelId)) {
    // K3(模型级,跨渠道):pi 对官方 moonshot 探测 supportsReasoningEffort=false,须显式
    // 开回才能发档位;收拢与 off 不可关(null 隐藏 off 项)由映射表表达,与聊天引擎同表。
    return {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { off: null, ...EFFORT_LOW_HIGH_MAX_BY_LEVEL },
    };
  }
  const protocol = openAiThinkingSwitchProtocol(host, model.modelId);
  if (protocol === "enable-thinking-flag") {
    // DashScope/SiliconFlow 白名单:qwen format 发 enable_thinking;这些端点不认
    // reasoning_effort,压制(聊天引擎同样不发)。
    return { compat: { thinkingFormat: "qwen", supportsReasoningEffort: false } };
  }
  if (protocol === "thinking-type-object") {
    if (host === "api.deepseek.com") {
      // DeepSeek 官方:pi 原生 deepseek format(thinking:{type}+reasoning_effort)幂等
      // 锁定;effort 只认 low/high/max,收拢喂方言同表(off 不标 null:可关思考,off 时
      // pi 发 thinking:{type:"disabled"},与聊天引擎一致)。
      return { compat: { thinkingFormat: "deepseek" }, thinkingLevelMap: { ...EFFORT_LOW_HIGH_MAX_BY_LEVEL } };
    }
    if (host === "open.bigmodel.cn") {
      // 智谱:pi 原生 zai format(thinking:{type,clear_thinking};effort 探测已关)幂等锁定。
      return { compat: { thinkingFormat: "zai" } };
    }
    // 火山方舟/Moonshot K2.5/K2.6:deepseek format 发 thinking:{type},端点不认
    // reasoning_effort,压制。
    return { compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false } };
  }
  if (protocol === "thinking-mode-flag" || protocol === "suppress") {
    // 书生(pi 无 thinking_mode 旋钮)/SiliconFlow 白名单外(发 enable_thinking 会 400)/
    // K2.7-code(始终思考,开关拒收):压制全部思考字段,模型走默认行为。
    return { compat: { supportsReasoningEffort: false } };
  }
  // reasoning-effort 协议(官方/混元/阶跃/未知中转):字段与格式 pi 默认已对,但 pi 对
  // xhigh/max 两档默认不放行(getSupportedThinkingLevels 仅 thinkingLevelMap 显式登记
  // 才支持),MAX 档会被 clamp 到 high——与聊天引擎默认分支"档位原样透传(含 xhigh/max,
  // 安卓对齐)"分歧(engine-request-diff 实证:chat=max/pi=high)。登记同名映射放行,
  // 两引擎逐字收敛;其余四档 pi 天然放行且不映射,勿画蛇添足。
  return { thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
}

/** 映射不到时给用户看的原因（模型选择器过滤面与错误提示共用，方案"诚实披露，不硬塞"）。 */
export function mapProviderModelToPi(provider: Provider, model: Model, limits?: PiModelLimits): PiMappingResult {
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
  const compatOverrides = piCompatOverridesFor(provider, api);
  // 思考开关翻译按协议分派:openai-completions 走厂商方言矩阵(K3 判定在函数内,
  // 模型级跨渠道);anthropic-messages 镜像聊天引擎 adaptive 方言(见函数头注);
  // google/responses 字段与格式 pi 原生已对,但 xhigh/max 两档须同名登记放行(pi
  // getSupportedThinkingLevels 缺映射会钳 high),聊天引擎两处均原样透传:responses
  // 发 reasoning.effort=档位,google 折预算(vendor 扩键后 xhigh/max 精确命中注入表)。
  const thinkingOverrides =
    api === "openai-completions"
      ? piThinkingOverridesFor(provider, model)
      : api === "anthropic-messages"
        ? piAnthropicThinkingOverrides()
        : { thinkingLevelMap: { xhigh: "xhigh", max: "max" } };

  const contextWindow =
    typeof limits?.contextWindow === "number" && limits.contextWindow > 0
      ? limits.contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  // max_tokens 不越过窗口(异常目录数据防御:output ≥ context 时请求会被上游拒绝)。
  const maxTokens = Math.min(
    typeof limits?.maxTokens === "number" && limits.maxTokens > 0 ? limits.maxTokens : DEFAULT_OUTPUT_TOKENS,
    contextWindow,
  );

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
        contextWindow,
        maxTokens,
        // 厂商思考开关+档位收拢(方言单源,与聊天引擎同表同判定;见 piThinkingOverridesFor 头注)。
        ...(thinkingOverrides?.thinkingLevelMap ? { thinkingLevelMap: thinkingOverrides.thinkingLevelMap } : {}),
        // 请求口径对齐聊天引擎(缺陷修复与依据见 piCompatOverridesFor/piThinkingOverridesFor 头注)。
        ...(compatOverrides || thinkingOverrides?.compat
          ? { compat: { ...compatOverrides, ...thinkingOverrides?.compat } }
          : {}),
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
