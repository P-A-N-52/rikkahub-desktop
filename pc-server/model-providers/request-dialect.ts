/** 统一请求方言（request dialect）——跨引擎出站请求口径的单一事实源。
 *
 *  背景（2.0.0 内测缺陷 1/2 + kelivo 对照审计，台账 T4.6/T4.7）：同一个 provider，
 *  聊天引擎与工作区引擎（pi）各自决定请求形状时必然漂移——pi 按「官方 OpenAI 能力」
 *  假设未知端点，聊天引擎按国内生态口径硬编码，谁都没错但两边不一致就是缺陷。
 *  kelivo 的终态（4100 行单文件、十几个厂商布尔散布在构建逻辑里）证明了不分层的
 *  代价；我们的分层：
 *
 *    层1（本模块）：引擎中性的「方言事实」——host 字符串进、口径结论出，纯函数零依赖。
 *    层2（各引擎翻译层）：聊天引擎构建体直接消费；pi 经 model-bridge 译成 compat；
 *         未来引擎的桥接层译成它自己的旋钮。引擎特有能力（如聊天引擎的厂商思考
 *         开关 reasoningPayloadForProvider）不属于方言，留在各自构建层。
 *    层3（平价回归测试）：跨引擎 e2e 断言真实出站字节一致（pi-route.test.ts）。
 *
 *  收录门槛：**跨引擎必须一致 + 有实证（内测/生产报错或官方文档硬性要求）**。
 *  不做 kelivo 式的推测性厂商全覆盖——没有实证的字段进来只会腐烂。
 *
 *  范围：OpenAI 兼容协议（completions/responses）。claude/google 协议各只有一个
 *  规范实现，两引擎无分歧空间，不需要方言。 */

/** 官方 OpenAI 系主机（api.openai.com / Azure OpenAI）。
 *  这是方言里唯一需要区别对待的主机族：o 系/gpt-5 的 chat completions 硬性要求
 *  max_completion_tokens（对 max_tokens 直接 400）；而第三方 OpenAI 兼容端点普遍
 *  只认 max_tokens。Azure 判定与 kelivo 的 isAzureOpenAI 特判互为印证。 */
export function isOfficialOpenAiHost(host: string): boolean {
  return host === "api.openai.com" || host.endsWith(".openai.azure.com");
}

/** 方言事实：系统提示词永不使用 "developer" 角色，恒发 "system"。
 *  官方 OpenAI 对推理模型同样接受 "system" 并自动归一；第三方端点普遍拒收
 *  "developer"（DashScope 类 400 拒角色枚举、火山方舟报 missing input.role，
 *  2.0.0 内测缺陷 1/2）。聊天引擎由构造保证（全仓库零 "developer"）；pi 经
 *  model-bridge 译成 compat.supportsDeveloperRole。 */
export const OPENAI_DEVELOPER_ROLE_ALLOWED = false;

/** 方言事实：chat completions 的输出上限字段名（responses 协议原生 max_output_tokens，
 *  无此分歧）。官方主机 → max_completion_tokens（o 系硬性要求，全部现役官方模型
 *  接受）；其余一律 max_tokens（第三方端点对未知字段多为**静默忽略**，发
 *  max_completion_tokens 等于上限失效、成本失控）。 */
export function openAiMaxTokensField(host: string): "max_tokens" | "max_completion_tokens" {
  return isOfficialOpenAiHost(host) ? "max_completion_tokens" : "max_tokens";
}

// ===== Kimi（Moonshot）代际事实 =====
// K3 发布后官方逐代收紧请求约束（platform.kimi.com「思考模型/模型参数参考」）。
// 代际判定是模型级事实、跨渠道成立（官方 api.moonshot.cn、硅基流动、透传型中转
// 都跑同一个模型），必须跨引擎一致——否则聊天模式认 K3 而工作区不认，行为分裂。
// 正则对齐安卓 ModelRegistry 的 token 匹配语义（kimi,k,N 连续 token：kimi-k3 /
// Kimi-K3-Turbo / moonshotai/Kimi-K3 都命中），(?![0-9]) 防 k30/k2.56 误伤，
// k3.5 等同代小版本自动延续同规则。

/** K3 系（kimi-k3/k3.5…；裸 id "k3" 对齐安卓 KIMI_K3_ALIAS）。 */
const KIMI_K3_RE = /(kimi[-._/]?k[-._]?3(?![0-9])|^k3$)/i;
/** K2.7-code(-highspeed)：始终思考，thinking 传 disabled 直接 400。 */
const KIMI_K2_7_RE = /kimi[-._/]?k[-._]?2[-._]7(?![0-9])/i;
/** K2.6：thinking 可开关；开思考需显式 keep:"all" 才保留历史思考（安卓 #1586）。 */
const KIMI_K2_6_RE = /kimi[-._/]?k[-._]?2[-._]6(?![0-9])/i;
/** K2.5 起（含 K2.6/K2.7/K3）temperature/top_p 等采样参数官方固定，明示"请勿显式
 *  传入"；安卓禁 K2.5/K2.6/K3/裸k3，按官方文档补 K2.7-code。 */
const KIMI_SAMPLING_LOCKED_RE = /(kimi[-._/]?k[-._]?(3|2[-._][567])(?![0-9])|^k3$)/i;

export function isKimiK3Model(modelId: string): boolean {
  return KIMI_K3_RE.test(modelId);
}
export function isKimiK27Model(modelId: string): boolean {
  return KIMI_K2_7_RE.test(modelId);
}
export function isKimiK26Model(modelId: string): boolean {
  return KIMI_K2_6_RE.test(modelId);
}
export function isKimiSamplingLockedModel(modelId: string): boolean {
  return KIMI_SAMPLING_LOCKED_RE.test(modelId);
}

/** Kimi 推理代际(模型级事实):K2.5 起全系支持思考——K2.5/K2.6 开关型(thinking.type)、
 *  K2.7-code 常开、K3 effort 型。能力推断(inferModelAbilities)消费本谓词补 REASONING
 *  能力位;此前推断正则无任何 Kimi 模式,Kimi 模型能力位缺失 → UI 推理选项不显示、
 *  两引擎思考链路整条未激活(supportsAbility/model.reasoning 守卫全部短路)。
 *  与采样锁定谓词今天同值域(共用正则),但语义独立(思考能力 vs 采样参数),分开命名。 */
export function isKimiReasoningModel(modelId: string): boolean {
  return KIMI_SAMPLING_LOCKED_RE.test(modelId);
}

/** 方言事实：思考预算表(token)——安卓 ReasoningLevel 枚举对齐(含 MAX=32000)。
 *  消费面:聊天引擎 Google thinkingConfig.thinkingBudget、DashScope/火山 thinking_budget;
 *  工作区引擎经 model-bridge PI_THINKING_BUDGETS(四键推导)喂 pi 受控 settings,
 *  Google 2.x 预算通道两引擎同数值。未知档兜底 8000(安卓 else 分支同值)。 */
export const THINKING_BUDGET_BY_LEVEL: Readonly<Record<string, number>> = {
  off: 0,
  low: 1_000,
  medium: 2_000,
  high: 8_000,
  xhigh: 16_000,
  max: 32_000,
};

export function budgetTokensFor(level: string): number {
  return THINKING_BUDGET_BY_LEVEL[level] ?? 8_000;
}

/** 方言事实：输出上限的最终兜底(助手未设且模型目录无输出上限时)。Anthropic 协议
 *  max_tokens 必填,安卓对齐取 64000;聊天引擎 Claude 分支、辅助任务、工作区引擎
 *  model-bridge 共用,禁止各处魔数。 */
export const DEFAULT_OUTPUT_TOKENS = 64_000;

/** 档位归一化（方言事实：用户档位值域的入口收拢）——安卓对齐的大写枚举（AUTO/OFF/
 *  MINIMAL/…/MAX）统一小写，off/none 归并为 off。聊天引擎全部拼装分支、auxiliary、
 *  工作区引擎（model-bridge 的 pi 档位翻译）共用本函数，禁止各处自行 lowercase。 */
export function reasoningLevelNormalized(level: string | null | undefined) {
  const normalized = String(level ?? "").toLowerCase();
  return normalized === "off" || normalized === "none" ? "off" : normalized;
}

/** 方言事实：Kimi K3 的 effort 收拢表（官方移除 thinking，effort 是唯一强度入口，
 *  只认 low/high/max，默认 max，非法值 400）。聊天引擎拼入请求体、pi 经 model-bridge
 *  喂给 thinkingLevelMap（pi 运行时查同一张表）。off 语义：K3 无法关思考→聊天映 low、
 *  pi 标 null 隐藏 off 项。auto＝不发字段。
 *  注意：DeepSeek 已拆出独立表（官方 2026-09 文档 xhigh→high，与 K3 的 xhigh→max
 *  口径不同），勿再共用本表。 */
export const EFFORT_LOW_HIGH_MAX_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

/** 六档收拢查表；未知档位返回 undefined，由调用方决定兜底。 */
export function effortLowHighMaxFor(level: string): "low" | "high" | "max" | undefined {
  return (EFFORT_LOW_HIGH_MAX_BY_LEVEL as Record<string, "low" | "high" | "max">)[level];
}

/** 方言事实：DeepSeek v4 官方 effort 收拢表（2026-09 thinking_mode 文档明表：
 *  low→low、medium→high、high→high、xhigh→high、max→max；v4-flash 与 v4-pro 同表）。
 *  服务端自身也做同款收拢，客户端对齐官方口径以保证语义一致（此前与 K3 共用
 *  xhigh→max 表，会让 xhigh 用户实际获得比官方语义强一档的 max）。 */
export const DEEPSEEK_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
} as const;

export function deepseekEffortFor(level: string): "low" | "high" | "max" | undefined {
  return (DEEPSEEK_EFFORT_BY_LEVEL as Record<string, "low" | "high" | "max">)[level];
}

/** 方言事实：智谱 GLM-5.3 的 effort 窄表（官方：仅收 max/high/low，其余值 400；
 *  收拢建议 none/minimal/low→low、medium/high→high、xhigh/max→max）。
 *  GLM-5.2 服务端收全七档并自行收拢（low/medium→high、xhigh→max），客户端原样
 *  透传即可，不查本表。 */
export const ZHIPU_GLM53_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

/** 方言事实：火山方舟 Doubao Seed 2.x 的 effort 表（官方：仅收 minimal/low/medium/
 *  high，minimal＝关思考，默认 medium；xhigh/max 收拢 high）。用户的 minimal 档映
 *  low 而非厂商 minimal：各家方言里 minimal＝"最少思考"而火山 minimal＝零思考，
 *  关思考的入口是 off 档（thinking:{type:"disabled"}），语义不混流。 */
export const ARK_SEED2_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

// ===== 思考强度的模型级谓词（方言单源：聊天引擎与各引擎桥接层共同消费）=====

/** 智谱 GLM-5.2 及以上支持 reasoning_effort（与 thinking.type 并发；5.1 及以下只认
 *  thinking 开关）。按版本号判定而非枚举：未来 GLM-5.4/6 默认放行。 */
export function isZhipuEffortModel(modelId: string): boolean {
  const m = /glm-(\d+)(?:\.(\d+))?/i.exec(modelId);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}

/** GLM-5.3 系（含 -flash）：effort 值域窄（仅 max/high/low），需查窄表收拢。 */
export function isZhipuGlm53Model(modelId: string): boolean {
  return /glm-5\.3/i.test(modelId);
}

/** 智谱强制思考型号（官方：GLM-5.3 系、GLM-4.7、GLM-4.5V 思考不可关，传
 *  thinking:{type:"disabled"} 直接 400）——off 档不得发 disabled。 */
export function isZhipuForcedThinkingModel(modelId: string): boolean {
  return /glm-5\.3/i.test(modelId) || /glm-4\.7/i.test(modelId) || /glm-4\.5v/i.test(modelId);
}

/** 火山方舟 Doubao Seed 2.x 及以上（doubao-seed-2-0-pro-260215 等）：支持
 *  reasoning_effort；老 doubao 系只认 thinking.type。 */
export function isArkSeed2Model(modelId: string): boolean {
  return /doubao-seed-[2-9]/i.test(modelId);
}

/** SiliconFlow 上支持 reasoning_effort 的托管模型（官方：DeepSeek-V4 系与
 *  Pro/zai-org/GLM-5.2；服务端自行收拢 low/medium→high、xhigh→max，客户端原样
 *  透传）。这些模型同时在 enable_thinking 白名单内，两字段并发。 */
export function isSiliconFlowEffortModel(modelId: string): boolean {
  return /deepseek-v4/i.test(modelId) || /glm-5\.2/i.test(modelId);
}

// ===== OpenAI 兼容生态：厂商思考开关协议（host 级事实 + SiliconFlow 模型白名单）=====
// 聊天引擎 reasoningPayloadForProvider 的 host 分支是协议的「实现」（拼具体厂商字段），
// 本节是协议的「声明」——工作区引擎经 model-bridge 译成 pi compat 消费同一声明，
// 未来引擎的桥接层同理。分类依据＝聊天引擎逐厂商实证（安卓对齐、几十个版本验证）
// 与各厂官方文档；全面审查 7 的产物：此前工作区对智谱/DeepSeek 被 pi 探测强制发
// thinking:{type:"disabled"} 关思考、对 DashScope/火山/SiliconFlow 完全失控。

/** SiliconFlow 支持 enable_thinking 的模型白名单（跨引擎事实：对白名单外模型发
 *  enable_thinking 会 400，聊天引擎与工作区引擎必须同一份名单）。 */
export const SILICONFLOW_THINKING_MODELS: ReadonlySet<string> = new Set([
  "Pro/moonshotai/Kimi-K2.5",
  "Pro/zai-org/GLM-5",
  "Pro/zai-org/GLM-5.1",
  "Pro/zai-org/GLM-4.7",
  "deepseek-ai/DeepSeek-V3.2",
  "Pro/deepseek-ai/DeepSeek-V3.2",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.5-122B-A10B",
  "Qwen/Qwen3.5-35B-A3B",
  "Qwen/Qwen3.5-27B",
  "Qwen/Qwen3.5-9B",
  "Qwen/Qwen3.5-4B",
  "zai-org/GLM-4.6",
  "Qwen/Qwen3-8B",
  "Qwen/Qwen3-14B",
  "Qwen/Qwen3-32B",
  "Qwen/Qwen3-30B-A3B",
  "Qwen/Qwen3-235B-A22B",
  "tencent/Hunyuan-A13B-Instruct",
  "zai-org/GLM-4.5V",
  "zai-org/GLM-4.6V",
  "zai-org/GLM-5V-Turbo",
  "deepseek-ai/DeepSeek-V3.1",
  "deepseek-ai/DeepSeek-V3.2-Exp",
  "deepseek-ai/DeepSeek-V3.1-Terminus",
  "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
  "deepseek-ai/DeepSeek-V4-Flash",
  "Pro/deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-ai/DeepSeek-V4-Pro",
  "Pro/deepseek-ai/DeepSeek-V4-Pro",
]);

/** 厂商思考开关的上游协议种类：
 *  - enable-thinking-flag：顶层 enable_thinking: boolean（DashScope 全线、SiliconFlow
 *    白名单模型）。
 *  - thinking-type-object：thinking: { type: "enabled"|"disabled" }（火山方舟、智谱、
 *    DeepSeek 官方、Moonshot K2.5/K2.6；智谱另带 clear_thinking、DeepSeek 另带
 *    effort、K2.6 另带 keep——对象内差异由各引擎翻译层处理）。
 *  - thinking-mode-flag：顶层 thinking_mode: boolean（书生浦语专用；聊天引擎已实现，
 *    pi 无对应旋钮→工作区压制思考字段，模型走默认行为）。
 *  - reasoning-effort：OpenAI 原生顶层 reasoning_effort（官方/Kimi K3/混元/阶跃/各类
 *    中转兜底）。
 *  - suppress：不发任何思考开关（SiliconFlow 白名单外模型；Moonshot K2.7-code 始终
 *    思考、开关字段被拒收）。 */
export type OpenAiThinkingSwitchProtocol =
  | "enable-thinking-flag"
  | "thinking-type-object"
  | "thinking-mode-flag"
  | "reasoning-effort"
  | "suppress";

export function openAiThinkingSwitchProtocol(host: string, modelId: string): OpenAiThinkingSwitchProtocol {
  if (host === "dashscope.aliyuncs.com") return "enable-thinking-flag";
  if (host === "api.siliconflow.cn") {
    return SILICONFLOW_THINKING_MODELS.has(modelId) ? "enable-thinking-flag" : "suppress";
  }
  if (host === "ark.cn-beijing.volces.com" || host === "open.bigmodel.cn" || host === "api.deepseek.com") {
    return "thinking-type-object";
  }
  if (host === "api.moonshot.cn") {
    if (isKimiK3Model(modelId)) return "reasoning-effort"; // K3 移除 thinking,唯一强度入口
    if (isKimiK27Model(modelId)) return "suppress"; // 始终思考,开关字段拒收
    return "thinking-type-object"; // K2.6/K2.5/kimi-latest
  }
  if (host === "chat.intern-ai.org.cn") return "thinking-mode-flag";
  return "reasoning-effort";
}

// ===== 采样参数锁定（模型级事实，跨引擎）=====

/** 方言事实：temperature/top_p 等采样参数被官方锁定的模型族——o 系推理模型与精确
 *  "gpt-5"（temperature≠1 直接 400；gpt-5.1+ 官方恢复可调，安卓同语义放行）、
 *  Kimi K2.5+（固定值，官方明示"请勿显式传入"）。
 *  消费面：聊天引擎 isModelAllowTemperature（orchestrator 主对话 + auxiliary 的
 *  temperature 与 top_p）；工作区引擎当前不发任何采样参数（runner 不传，pi 仅在
 *  显式传入时才发），接通助手温度设置时必须消费本谓词，禁止另起判定。 */
export function isSamplingLockedModel(modelId: string): boolean {
  return /(^o\d|[/:_-]o\d)/i.test(modelId) || /^gpt[-._]?5$/i.test(modelId) || isKimiSamplingLockedModel(modelId);
}
