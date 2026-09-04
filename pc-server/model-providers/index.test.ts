// model-providers/index 纯函数单测:能力推断(Kimi 代际经方言谓词——回归锁)。
import { describe, expect, it } from "bun:test";

import { inferModelAbilities } from "./index";

describe("inferModelAbilities", () => {
  it("Kimi K2.5+ 全系推理(方言谓词;曾因正则无 kimi 模式致能力位缺失:UI 无推理选项、两引擎思考链路未激活)", () => {
    for (const id of [
      "kimi-k3",
      "kimi-k3.5",
      "k3",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "Pro/moonshotai/Kimi-K2.5",
      "kimi-thinking-preview", // 关键词 thinking 兜住(既有行为)
    ]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    // 旧代不误伤:legacy 模型非推理。
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });

  it("既有模式回归锁:主流推理模型仍识别,常规模型不误伤", () => {
    for (const id of ["gpt-5", "o3-mini", "deepseek-reasoner", "qwen3-max", "glm-5", "claude-opus-4-6", "gemini-2.5-pro", "grok-4"]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    for (const id of ["gpt-4o", "gemini-2.0-flash", "llama-3.3-70b"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });
});
