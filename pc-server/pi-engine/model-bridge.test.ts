// model-bridge 单测：协议映射矩阵、URL 口径差、鉴权占位、registerProvider 内存注册闭环。
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

import { piAgentDir } from "../foundation/paths";
import { model, provider } from "../model-providers";
import { createPiModelRuntime, mapProviderModelToPi, piApiFor } from "./model-bridge";

function makeProvider(input: Parameters<typeof provider>[0]) {
  return provider({ apiKey: "sk-test", ...input });
}

describe("piApiFor 协议映射矩阵", () => {
  it("openai 默认 → openai-completions", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }))).toBe("openai-completions");
  });
  it("openai + useResponseApi → openai-responses", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1", useResponseApi: true }))).toBe(
      "openai-responses",
    );
  });
  it("openai + 自定义补全路径 → 无法映射", () => {
    expect(
      piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", chatCompletionsPath: "/api/v3/chat" })),
    ).toBeNull();
  });
  it("claude → anthropic-messages;google → google-generative-ai", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", type: "claude" }))).toBe(
      "anthropic-messages",
    );
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", type: "google" }))).toBe(
      "google-generative-ai",
    );
  });
});

describe("mapProviderModelToPi", () => {
  it("claude 剥尾部 /v1(pi 的 SDK 自己拼 /v1/messages);openai/google 逐字透传", () => {
    const claude = mapProviderModelToPi(
      makeProvider({ id: "pc", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
      model("claude-sonnet-4-5"),
    );
    if (!claude.ok) throw new Error(claude.reason);
    expect(claude.mapping.config.baseUrl).toBe("https://api.anthropic.com");

    const google = mapProviderModelToPi(
      makeProvider({
        id: "pg",
        name: "G",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        type: "google",
      }),
      model("gemini-2.5-pro"),
    );
    if (!google.ok) throw new Error(google.reason);
    expect(google.mapping.config.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");

    const openai = mapProviderModelToPi(
      makeProvider({ id: "po", name: "O", baseUrl: "https://api.openai.com/v1" }),
      model("gpt-4.1"),
    );
    if (!openai.ok) throw new Error(openai.reason);
    expect(openai.mapping.config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("空密钥 → 占位符(pi 组合器要求非空;等价我们侧发空 Bearer)", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" }),
      model("qwen3:8b"),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.mapping.config.apiKey).toBe("unused");
  });

  it("Kimi K3:thinkingLevelMap 喂入方言收拢表(off:null 无法关思考)+effort 显式开回(pi 对 moonshot 探测 false)", () => {
    // 跨渠道成立:官方 host 或第三方中转,判定只看模型 id(K3 事实是模型级)。
    for (const baseUrl of ["https://relay.example.com/v1", "https://api.moonshot.cn/v1"]) {
      const k3 = mapProviderModelToPi(makeProvider({ id: "pk", name: "P", baseUrl }), model("kimi-k3"));
      if (!k3.ok) throw new Error(k3.reason);
      expect(k3.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      });
      expect((k3.mapping.config.models?.[0]?.compat as any)?.supportsReasoningEffort).toBe(true);
    }
  });

  it("厂商思考开关翻译(全面审查 7):方言协议 → pi thinkingFormat/supportsReasoningEffort", () => {
    const compatOf = (baseUrl: string, modelId: string) => {
      const result = mapProviderModelToPi(makeProvider({ id: "pt", name: "P", baseUrl }), model(modelId));
      if (!result.ok) throw new Error(result.reason);
      return {
        compat: result.mapping.config.models?.[0]?.compat as Record<string, unknown> | undefined,
        thinkingLevelMap: result.mapping.config.models?.[0]?.thinkingLevelMap,
      };
    };

    // DashScope:qwen format 发 enable_thinking;effort 端点不认,压制。
    const dashscope = compatOf("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max");
    expect(dashscope.compat?.thinkingFormat).toBe("qwen");
    expect(dashscope.compat?.supportsReasoningEffort).toBe(false);

    // SiliconFlow:白名单模型走 qwen format;白名单外压制(发 enable_thinking 会 400)。
    const sfListed = compatOf("https://api.siliconflow.cn/v1", "Qwen/Qwen3.5-397B-A17B");
    expect(sfListed.compat?.thinkingFormat).toBe("qwen");
    expect(sfListed.compat?.supportsReasoningEffort).toBe(false);
    const sfUnlisted = compatOf("https://api.siliconflow.cn/v1", "meta-llama/Llama-3.3-70B");
    expect(sfUnlisted.compat?.thinkingFormat).toBeUndefined();
    expect(sfUnlisted.compat?.supportsReasoningEffort).toBe(false);

    // 火山方舟:deepseek format 发 thinking:{type};effort 压制。
    const ark = compatOf("https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2.0");
    expect(ark.compat?.thinkingFormat).toBe("deepseek");
    expect(ark.compat?.supportsReasoningEffort).toBe(false);

    // 智谱:zai format 幂等锁定(与 pi 探测同值,口径由方言决定)。
    const zhipu = compatOf("https://open.bigmodel.cn/api/paas/v4", "glm-5");
    expect(zhipu.compat?.thinkingFormat).toBe("zai");

    // DeepSeek 官方:deepseek format+档位收拢表(off 不标 null:可关思考走 thinking disabled)。
    const deepseek = compatOf("https://api.deepseek.com/v1", "deepseek-reasoner");
    expect(deepseek.compat?.thinkingFormat).toBe("deepseek");
    expect(deepseek.thinkingLevelMap).toEqual({
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    });

    // Moonshot K2.6:thinking:{type}(deepseek format);K2.7:始终思考,全部压制。
    const k26 = compatOf("https://api.moonshot.cn/v1", "kimi-k2.6");
    expect(k26.compat?.thinkingFormat).toBe("deepseek");
    expect(k26.compat?.supportsReasoningEffort).toBe(false);
    const k27 = compatOf("https://api.moonshot.cn/v1", "kimi-k2.7-code");
    expect(k27.compat?.thinkingFormat).toBeUndefined();
    expect(k27.compat?.supportsReasoningEffort).toBe(false);

    // 书生:thinking_mode pi 无旋钮,压制思考字段(工作区已知降级,聊天引擎单边支持)。
    const intern = compatOf("https://chat.intern-ai.org.cn/api/v1", "intern-s1");
    expect(intern.compat?.supportsReasoningEffort).toBe(false);

    // 兜底(混元/中转):pi openai format+effort 默认已对,不覆盖思考字段(仍带
    // developer role/maxTokensField 基础口径)。
    const hunyuan = compatOf("https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-t1");
    expect(hunyuan.compat?.thinkingFormat).toBeUndefined();
    expect(hunyuan.compat?.supportsReasoningEffort).toBeUndefined();

    // NVIDIA:pi 白名单实证关 effort(值域特殊),尊重探测不覆盖。
    const nvidia = compatOf("https://integrate.api.nvidia.com/v1", "deepseek-ai/deepseek-v4");
    expect(nvidia.compat?.thinkingFormat).toBeUndefined();
    expect(nvidia.compat?.supportsReasoningEffort).toBeUndefined();

    // anthropic/google 协议:各有原生思考协议,不适用本翻译。
    const claude = mapProviderModelToPi(
      makeProvider({ id: "pc", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
      model("claude-sonnet-4-5"),
    );
    if (!claude.ok) throw new Error(claude.reason);
    expect((claude.mapping.config.models?.[0]?.compat as any)?.thinkingFormat).toBeUndefined();
  });

  it("能力/模态位翻译:REASONING→reasoning,IMAGE→input 含 image", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }),
      model("gemini-2.5-pro"), // 工厂会推断 REASONING + IMAGE
    );
    if (!result.ok) throw new Error(result.reason);
    const entry = result.mapping.config.models?.[0];
    expect(entry?.reasoning).toBe(true);
    expect(entry?.input).toEqual(["text", "image"]);
  });

  it("compat 覆盖矩阵:请求口径与聊天引擎对齐(2.0.0 内测缺陷 1/2 回归锁)", () => {
    // pi 对未知 baseUrl 的 compat 自动探测按官方 OpenAI 能力假设:推理模型系统消息发
    // "developer" 角色(第三方端点 400 拒收)、上限字段发 max_completion_tokens(第三方
    // 端点静默忽略→上限失效)。覆盖依据详见 model-bridge piCompatOverridesFor 头注。
    const compatOf = (result: ReturnType<typeof mapProviderModelToPi>) => {
      if (!result.ok) throw new Error(result.reason);
      return result.mapping.config.models?.[0]?.compat;
    };

    // 第三方 OpenAI 兼容端点(内测环境):恒 system + 恒 max_tokens。火山方舟另带
    // 思考开关翻译(thinking:{type} 走 deepseek format,effort 压制;全面审查 7)。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p1", name: "Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
        model("deepseek-r1"),
      )),
    ).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "deepseek",
      supportsReasoningEffort: false,
    });

    // 官方 OpenAI / Azure:恒 system + 显式 max_completion_tokens(o 系 chat completions
    // 硬要求;与 pi 自动探测同值,显式写死 = 口径由方言单源决定,T4.7)。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p2", name: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
        model("o3"),
      )),
    ).toEqual({ supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" });
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p3", name: "Azure", baseUrl: "https://my-rg.openai.azure.com/openai/v1" }),
        model("o3"),
      )),
    ).toEqual({ supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" });

    // Responses 协议:原生 max_output_tokens,只需角色覆盖。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p4", name: "Ark-R", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", useResponseApi: true }),
        model("deepseek-r1"),
      )),
    ).toEqual({ supportsDeveloperRole: false });

    // claude/google 协议无以上概念,compat 保持不设(各自 compat 类型契约不同)。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p5", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
        model("claude-sonnet-4-5"),
      )),
    ).toBeUndefined();
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p6", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" }),
        model("gemini-2.5-pro"),
      )),
    ).toBeUndefined();
  });

  it("模型级自定义头透传(与聊天引擎 applyModelRequestHeaders 同源)", () => {
    const custom = { ...model("gpt-4.1"), customHeaders: [{ name: "X-Proxy-Token", value: "t1" }] };
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }),
      custom,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.mapping.config.headers?.["X-Proxy-Token"]).toBe("t1");
  });

  it("无法映射时给出可读原因(诚实过滤面)", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x", chatCompletionsPath: "/api/v3/chat" }),
      model("m"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/api/v3/chat");
  });
});

describe("createPiModelRuntime 内存注册闭环", () => {
  it("registerProvider 注册后 getModel 可取,且零落盘", async () => {
    const mapped = mapProviderModelToPi(
      makeProvider({ id: "11111111-2222-3333-4444-555555555555", name: "我的中转", baseUrl: "https://relay.example/v1" }),
      model("gpt-4.1", "GPT 4.1"),
    );
    if (!mapped.ok) throw new Error(mapped.reason);

    const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);
    expect(piModel.id).toBe("gpt-4.1");
    expect(piModel.provider).toBe("11111111-2222-3333-4444-555555555555");
    expect(piModel.api).toBe("openai-completions");
    expect(piModel.baseUrl).toBe("https://relay.example/v1");
    expect(runtime.hasConfiguredAuth(piModel.provider)).toBe(true);

    // 零落盘:客房目录整个不存在(auth 用内存存储,models 用内存 store,方案 §3.5 红线)。
    expect(existsSync(piAgentDir)).toBe(false);
  });
});
