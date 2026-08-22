import { describe, expect, test } from "bun:test";

import type { FontEntry } from "~/types/font";
import {
  buildCjkOverrideCss,
  CJK_UNICODE_RANGE,
  composeFontChain,
  entryMatches,
} from "~/lib/font-chain";

describe("composeFontChain", () => {
  test("未设中文字体时原链返回", () => {
    expect(composeFontChain('"Arial", sans-serif', "rk-cjk", false)).toBe('"Arial", sans-serif');
  });
  test("设了中文字体时覆盖族置于链首", () => {
    expect(composeFontChain('"Arial", sans-serif', "rk-cjk", true)).toBe(
      '"rk-cjk", "Arial", sans-serif',
    );
  });
  test("基链为空且设了中文字体时只剩覆盖族", () => {
    expect(composeFontChain("", "rk-cjk", true)).toBe('"rk-cjk"');
  });
  test("基链为空且未设中文字体时返回空(由调用方兜底)", () => {
    expect(composeFontChain("  ", "rk-cjk", false)).toBe("");
  });
});

describe("buildCjkOverrideCss", () => {
  const fileEntry: FontEntry = {
    id: "builtin:noto-serif-sc",
    label: "Noto Serif SC",
    cssName: "Noto Serif SC",
    family: '"Noto Serif SC", serif',
    source: "builtin",
    weights: [
      { fileName: "NotoSerifSC-Regular.ttf", weight: 400, style: "normal", format: "truetype" },
      { fileName: "NotoSerifSC-Bold.ttf", weight: 700, style: "normal", format: "truetype" },
    ],
  };
  const systemEntry: FontEntry = {
    id: "system:KaiTi",
    label: "楷体",
    cssName: "KaiTi",
    family: '"KaiTi", system-ui, sans-serif',
    source: "system",
    weights: [],
  };

  test("文件字体:每字重一条 url 规则,带 unicode-range", () => {
    const css = buildCjkOverrideCss("rk-cjk", fileEntry, fileEntry.family);
    const rules = css.split("\n");
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain('font-family: "rk-cjk"');
    expect(rules[0]).toContain("/api/fonts/builtin/NotoSerifSC-Regular.ttf");
    expect(rules[0]).toContain("font-weight: 400");
    expect(rules[1]).toContain("font-weight: 700");
    for (const rule of rules) expect(rule).toContain(`unicode-range: ${CJK_UNICODE_RANGE}`);
  });

  test("系统字体:单条 local 规则,匹配全部字重", () => {
    const css = buildCjkOverrideCss("rk-cjk", systemEntry, systemEntry.family);
    expect(css).toContain('src: local("KaiTi")');
    expect(css).toContain("font-weight: 100 900");
    expect(css).toContain(`unicode-range: ${CJK_UNICODE_RANGE}`);
  });

  test("无条目(老数据):从链提取具体字体名作 local 列表,跳过 generic 与 var()", () => {
    const css = buildCjkOverrideCss(
      "rk-cjk",
      null,
      '"思源宋体", Georgia, serif, system-ui, var(--font-sans)',
    );
    expect(css).toContain('local("思源宋体"), local("Georgia")');
    expect(css).not.toContain("serif,");
    expect(css).not.toContain("var(");
  });

  test("纯 generic 栈:返回空(覆盖族不存在,链穿透到英文字体)", () => {
    expect(buildCjkOverrideCss("rk-cjk", null, "ui-serif, serif")).toBe("");
    expect(buildCjkOverrideCss("rk-cjk", null, "")).toBe("");
  });
});

describe("entryMatches", () => {
  const entry = { id: "system:Arial", label: "Arial Label", legacyLabel: "旧名", cssName: "Arial" };
  test("按 id / label / legacyLabel / cssName 匹配", () => {
    expect(entryMatches(entry, "system:Arial")).toBe(true);
    expect(entryMatches(entry, "Arial Label")).toBe(true);
    expect(entryMatches(entry, "旧名")).toBe(true);
    expect(entryMatches(entry, "Arial")).toBe(true);
  });
  test("空值与不相关值不匹配", () => {
    expect(entryMatches(entry, "")).toBe(false);
    expect(entryMatches(entry, "Helvetica")).toBe(false);
  });
});
