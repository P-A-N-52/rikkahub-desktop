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
