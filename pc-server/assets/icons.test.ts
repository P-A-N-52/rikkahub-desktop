// 模型图标规则回归(内测反馈:K3 系列头像不对)。规则表按序首中,新增/调整规则时
// 这里的正反例保证既命中目标又不误伤近邻(词边界语义)。
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import { iconForName, iconRules, serveAIIcon } from "./icons";

describe("bundled AI icons", () => {
  // 直接检查规则引用的仓库资源，防止漏文件只在严格资源路径的安装包里报错。
  test.each([...new Set(iconRules.map(([, file]) => file))])("%s exists and is nonempty", (file) => {
    const resource = statSync(join(import.meta.dir, "../../icons", file));
    expect(resource.isFile()).toBe(true);
    expect(resource.size).toBeGreaterThan(0);
  });

  test("TinyFish serves its bundled SVG", async () => {
    expect(iconForName("TinyFish")).toBe("tinyfish.svg");
    const response = await serveAIIcon("TinyFish");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).not.toContain("<text");
  });
});

describe("iconForName", () => {
  test("Kimi 家族:官方 id 与裸 K 系列短名都命中", () => {
    expect(iconForName("kimi-k3")).toBe("kimi-color.svg");
    expect(iconForName("kimi-k2.7-code")).toBe("kimi-color.svg");
    expect(iconForName("kimi-latest")).toBe("kimi-color.svg");
    // 裸短名(聚合商列表/手动录入常见):词边界匹配
    expect(iconForName("k3")).toBe("kimi-color.svg");
    expect(iconForName("K3")).toBe("kimi-color.svg");
    expect(iconForName("k3.5")).toBe("kimi-color.svg");
    expect(iconForName("k4-preview")).toBe("kimi-color.svg");
  });

  test("不误伤近邻:k 前是字母时无词边界", () => {
    expect(iconForName("grok-3")).toBe("grok.svg");
    expect(iconForName("grok3")).toBe("grok.svg");
    expect(iconForName("deepseek3")).toBe("deepseek-color.svg");
    expect(iconForName("deepseek-v3")).toBe("deepseek-color.svg");
  });

  test("moonshot 命中月之暗面供应商图标", () => {
    expect(iconForName("moonshot-v1-8k")).toBe("moonshot.svg");
    expect(iconForName("月之暗面")).toBe("moonshot.svg");
  });
});
