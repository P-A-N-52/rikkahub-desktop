// 统一请求方言单测:host → 口径事实的映射矩阵(依据见 request-dialect.ts 头注)。
import { describe, expect, it } from "bun:test";
import {
  ARK_SEED2_EFFORT_BY_LEVEL,
  deepseekEffortFor,
  isArkSeed2Model,
  isKimiK26Model,
  isKimiK27Model,
  isKimiK3Model,
  isKimiReasoningModel,
  isKimiSamplingLockedModel,
  isSamplingLockedModel,
  isSiliconFlowEffortModel,
  isZhipuEffortModel,
  isZhipuForcedThinkingModel,
  isZhipuGlm53Model,
  EFFORT_LOW_HIGH_MAX_BY_LEVEL,
  effortLowHighMaxFor,
  OPENAI_DEVELOPER_ROLE_ALLOWED,
  isOfficialOpenAiHost,
  openAiMaxTokensField,
  openAiThinkingSwitchProtocol,
  SILICONFLOW_THINKING_MODELS,
  ZHIPU_GLM53_EFFORT_BY_LEVEL,
} from "./request-dialect";

describe("request-dialect 统一请求方言", () => {
  it("developer 角色事实:恒不允许(2.0.0 内测缺陷 1/2 根因)", () => {
    expect(OPENAI_DEVELOPER_ROLE_ALLOWED).toBe(false);
  });

  it("官方 OpenAI 系主机判定:api.openai.com 与 Azure OpenAI,其余(含国内生态)皆非", () => {
    expect(isOfficialOpenAiHost("api.openai.com")).toBe(true);
    expect(isOfficialOpenAiHost("my-rg.openai.azure.com")).toBe(true);
    // 前缀伪装不放行(endsWith 带点边界)。
    expect(isOfficialOpenAiHost("evil-api.openai.com.cn")).toBe(false);
    expect(isOfficialOpenAiHost("openai.azure.com.evil.cn")).toBe(false);
    expect(isOfficialOpenAiHost("ark.cn-beijing.volces.com")).toBe(false);
    expect(isOfficialOpenAiHost("dashscope.aliyuncs.com")).toBe(false);
    expect(isOfficialOpenAiHost("api.siliconflow.cn")).toBe(false);
    expect(isOfficialOpenAiHost("openrouter.ai")).toBe(false);
    expect(isOfficialOpenAiHost("127.0.0.1")).toBe(false);
    expect(isOfficialOpenAiHost("")).toBe(false);
  });

  it("上限字段名:官方口 max_completion_tokens(o 系硬要求),其余 max_tokens(第三方静默忽略未知字段)", () => {
    expect(openAiMaxTokensField("api.openai.com")).toBe("max_completion_tokens");
    expect(openAiMaxTokensField("my-rg.openai.azure.com")).toBe("max_completion_tokens");
    expect(openAiMaxTokensField("ark.cn-beijing.volces.com")).toBe("max_tokens");
    expect(openAiMaxTokensField("dashscope.aliyuncs.com")).toBe("max_tokens");
    expect(openAiMaxTokensField("127.0.0.1")).toBe("max_tokens");
  });
});

// Kimi 代际事实(platform.kimi.com「思考模型/模型参数参考」):模型级、跨渠道、跨引擎。
describe("request-dialect Kimi 代际", () => {
  it("K3 判定:kimi-k3 各形态/裸 k3(安卓 KIMI_K3_ALIAS)/k3.5 同代;k30 与 K2.x 不误伤", () => {
    expect(isKimiK3Model("kimi-k3")).toBe(true);
    expect(isKimiK3Model("Kimi-K3-Turbo")).toBe(true);
    expect(isKimiK3Model("moonshotai/Kimi-K3")).toBe(true);
    expect(isKimiK3Model("kimi-k3.5")).toBe(true);
    expect(isKimiK3Model("k3")).toBe(true);
    expect(isKimiK3Model("kimi-k30")).toBe(false);
    expect(isKimiK3Model("kimi-k2.6")).toBe(false);
    expect(isKimiK3Model("kimi-latest")).toBe(false);
  });

  it("K2.7/K2.6 判定:含 -code(-highspeed) 后缀;互不越界", () => {
    expect(isKimiK27Model("kimi-k2.7-code")).toBe(true);
    expect(isKimiK27Model("kimi-k2.7-code-highspeed")).toBe(true);
    expect(isKimiK27Model("kimi-k2.6")).toBe(false);
    expect(isKimiK26Model("kimi-k2.6")).toBe(true);
    expect(isKimiK26Model("kimi-k2.7-code")).toBe(false);
  });

  it("采样锁定:K2.5 起(含 K2.6/K2.7/K3/裸k3/第三方 id 形态)固定 temperature/top_p;旧代不锁", () => {
    for (const id of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "k3", "Pro/moonshotai/Kimi-K2.5"]) {
      expect(isKimiSamplingLockedModel(id)).toBe(true);
    }
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2", "gpt-4o"]) {
      expect(isKimiSamplingLockedModel(id)).toBe(false);
    }
  });

  it("推理代际谓词:K2.5 起全系支持思考(能力推断消费;与采样锁定同值域、语义分立)", () => {
    for (const id of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "kimi-k3.5", "k3", "Pro/moonshotai/Kimi-K2.5"]) {
      expect(isKimiReasoningModel(id)).toBe(true);
    }
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2", "gpt-4o"]) {
      expect(isKimiReasoningModel(id)).toBe(false);
    }
  });

  it("采样锁定(跨引擎谓词):o 系/精确 gpt-5/Kimi K2.5+ 锁;gpt-5.1+ 与常规模型放行", () => {
    for (const id of ["o3", "o1-mini", "provider/o4-mini", "gpt-5", "kimi-k3", "kimi-k2.5"]) {
      expect(isSamplingLockedModel(id)).toBe(true);
    }
    for (const id of ["gpt-5.1", "gpt-5.2-turbo", "gpt-4o", "kimi-latest", "claude-sonnet-4-5", "gemini-2.5-pro"]) {
      expect(isSamplingLockedModel(id)).toBe(false);
    }
  });

  it("档位收拢表(K3/DeepSeek 官方共用):六档→low/high/max(非法值即 400 的正确性表);未知档位 undefined 由调用方兜底", () => {
    expect(effortLowHighMaxFor("minimal")).toBe("low");
    expect(effortLowHighMaxFor("low")).toBe("low");
    expect(effortLowHighMaxFor("medium")).toBe("high");
    expect(effortLowHighMaxFor("high")).toBe("high");
    expect(effortLowHighMaxFor("xhigh")).toBe("max");
    expect(effortLowHighMaxFor("max")).toBe("max");
    expect(effortLowHighMaxFor("auto")).toBeUndefined();
    expect(effortLowHighMaxFor("off")).toBeUndefined();
    // 表值域封闭校验:任何映射产物都必须是 K3 合法值(防未来改表时手误)。
    for (const value of Object.values(EFFORT_LOW_HIGH_MAX_BY_LEVEL)) {
      expect(["low", "high", "max"]).toContain(value);
    }
  });
});

// 厂商思考开关协议(全面审查 7):host 级事实,聊天引擎按它拼字段、pi 引擎按它译 compat。
describe("request-dialect 厂商思考开关协议", () => {
  it("host 级判定:DashScope=enable_thinking;火山/智谱/DeepSeek=thinking.type;书生=thinking_mode;兜底=reasoning_effort", () => {
    expect(openAiThinkingSwitchProtocol("dashscope.aliyuncs.com", "qwen3-max")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("ark.cn-beijing.volces.com", "doubao-seed-2.0")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("open.bigmodel.cn", "glm-5")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.deepseek.com", "deepseek-reasoner")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("chat.intern-ai.org.cn", "intern-s1")).toBe("thinking-mode-flag");
    // 兜底:官方 OpenAI/混元/阶跃/中转——OpenAI 原生 reasoning_effort。
    expect(openAiThinkingSwitchProtocol("api.openai.com", "o3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.hunyuan.cloud.tencent.com", "hunyuan-t1")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.stepfun.com", "step-3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("relay.example.com", "some-model")).toBe("reasoning-effort");
  });

  it("SiliconFlow:白名单模型=enable_thinking,白名单外=suppress(发了会 400)", () => {
    expect(SILICONFLOW_THINKING_MODELS.size).toBeGreaterThan(0);
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "Qwen/Qwen3.5-397B-A17B")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "Pro/zai-org/GLM-5")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "meta-llama/Llama-3.3-70B")).toBe("suppress");
  });

  it("Moonshot 代际分派:K3=effort(thinking 已移除);K2.7=suppress(始终思考拒收开关);K2.6/K2.5/legacy=thinking.type", () => {
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.7-code")).toBe("suppress");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.6")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.5")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-latest")).toBe("thinking-type-object");
  });
});

// 2026-09 新格式方言:模型级谓词边界与新收拢表(官方文档口径,消费面=聊天引擎
// reasoningPayloadForProvider + 工作区 model-bridge,两引擎同源)。
describe("request-dialect 2026-09 新格式谓词与收拢表", () => {
  it("智谱版本谓词:5.2 起支持 effort(未来版本默认放行);5.3 窄表;强制思考=5.3 系/4.7/4.5V", () => {
    expect(isZhipuEffortModel("glm-5.1")).toBe(false);
    expect(isZhipuEffortModel("glm-5.2")).toBe(true);
    expect(isZhipuEffortModel("GLM-5.3-Flash")).toBe(true);
    expect(isZhipuEffortModel("glm-6")).toBe(true);
    expect(isZhipuEffortModel("glm-4.7")).toBe(false);
    expect(isZhipuGlm53Model("glm-5.3")).toBe(true);
    expect(isZhipuGlm53Model("glm-5.3-flash")).toBe(true);
    expect(isZhipuGlm53Model("glm-5.2")).toBe(false);
    expect(isZhipuForcedThinkingModel("glm-5.3")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.7")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.5v")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.6")).toBe(false);
    expect(isZhipuForcedThinkingModel("glm-5.2")).toBe(false);
  });

  it("火山 Seed 2.x 谓词与表:seed-2+ 命中(老 doubao 不);minimal 档映 low,xhigh/max 收 high", () => {
    expect(isArkSeed2Model("doubao-seed-2-0-pro-260215")).toBe(true);
    expect(isArkSeed2Model("doubao-seed-2.0")).toBe(true);
    expect(isArkSeed2Model("doubao-seed-3-pro")).toBe(true);
    expect(isArkSeed2Model("doubao-1.5-thinking-pro")).toBe(false);
    expect(ARK_SEED2_EFFORT_BY_LEVEL).toEqual({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    });
  });

  it("DeepSeek v4 表与 K3 表口径分歧锁定:DS xhigh→high(官方 2026-09),K3 xhigh→max", () => {
    expect(deepseekEffortFor("xhigh")).toBe("high");
    expect(deepseekEffortFor("max")).toBe("max");
    expect(deepseekEffortFor("medium")).toBe("high");
    expect(effortLowHighMaxFor("xhigh")).toBe("max");
  });

  it("智谱 5.3 窄表:服务端仅收 max/high/low,收拢建议官方口径", () => {
    expect(ZHIPU_GLM53_EFFORT_BY_LEVEL).toEqual({
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    });
  });

  it("硅基 effort 托管模型谓词:V4 系/GLM-5.2 命中,V3.2 不", () => {
    expect(isSiliconFlowEffortModel("Pro/deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
    expect(isSiliconFlowEffortModel("deepseek-ai/DeepSeek-V4-Flash")).toBe(true);
    expect(isSiliconFlowEffortModel("Pro/zai-org/GLM-5.2")).toBe(true);
    expect(isSiliconFlowEffortModel("deepseek-ai/DeepSeek-V3.2")).toBe(false);
  });

  it("白名单增量:2026-09 官方 enable_thinking 支持列表新条目", () => {
    for (const id of [
      "Qwen/Qwen3-235B-A22B",
      "zai-org/GLM-4.6V",
      "zai-org/GLM-5V-Turbo",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V3.2-Exp",
    ]) {
      expect(SILICONFLOW_THINKING_MODELS.has(id)).toBe(true);
    }
  });
});
