// incremental-shiki.test.ts — 行级增量分词与全量分词的逐 token 一致性(专题2 H-a)
// 用真实 shiki 高亮器对照:任意"只追加"序列下,增量结果的渲染字段必须与
// "对当前全文做一次全量 codeToTokens"完全一致。
import { describe, expect, test, beforeAll } from "bun:test";
import { createHighlighter, type BundledLanguage, type BundledTheme, type HighlighterGeneric, type ThemedToken } from "shiki";
import { createStreamingTokenizer } from "~/components/markdown/incremental-shiki";

const THEMES = { light: "catppuccin-latte", dark: "catppuccin-mocha" } as const;

let highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>;

beforeAll(async () => {
  highlighter = await createHighlighter({
    langs: ["tsx", "python", "markdown"],
    themes: [THEMES.light, THEMES.dark],
  });
});

/** 渲染相关字段快照(TokenSpan 实际消费的字段;offset 等元数据与渲染无关)。 */
function renderShape(tokens: ThemedToken[][]): string {
  return JSON.stringify(
    tokens.map((line) =>
      line.map((t) => [t.content, t.color, t.bgColor, t.fontStyle, t.htmlStyle ?? null]),
    ),
  );
}

function fullTokenize(code: string, lang: BundledLanguage) {
  return highlighter.codeToTokens(code, { lang, themes: THEMES });
}

/** 按给定切片序列逐帧喂给增量分词器,每帧对照全量分词。 */
function expectIncrementalMatchesFull(code: string, lang: BundledLanguage, steps: number[]) {
  const tokenizer = createStreamingTokenizer(highlighter, lang, THEMES);
  for (const end of steps) {
    const partial = code.slice(0, end);
    const { result } = tokenizer.tokenize(partial);
    const full = fullTokenize(partial, lang);
    expect(renderShape(result.tokens)).toBe(renderShape(full.tokens));
    expect(result.bg).toBe(full.bg ?? "transparent");
    expect(result.fg).toBe(full.fg ?? "inherit");
  }
}

const TSX_SAMPLE = `import * as React from "react";
// 注释:含中文与 \`反引号\`
const tpl = \`multi
line \${1 + 2} template
still inside\`;
/* block
   comment */
export function App({ items }: { items: string[] }) {
  return (
    <div className="a">
      {items.map((it) => (
        <span key={it}>{it}</span>
      ))}
    </div>
  );
}
`;

const PY_SAMPLE = `def compute(x):
    """docstring
    spanning lines"""
    s = '''triple
    quoted'''
    return [i * x for i in range(100)]  # comment

class Foo:
    pass
`;

describe("createStreamingTokenizer", () => {
  test("逐字符追加与全量一致(tsx,覆盖跨行模板串/JSX/块注释)", () => {
    const steps: number[] = [];
    for (let i = 1; i <= TSX_SAMPLE.length; i += 7) steps.push(i);
    steps.push(TSX_SAMPLE.length);
    expectIncrementalMatchesFull(TSX_SAMPLE, "tsx", steps);
  });

  test("按行/大块追加与全量一致(python,覆盖 docstring/三引号)", () => {
    const steps = [1, 5, 20, 60, 61, 62, 100, 180, PY_SAMPLE.length];
    expectIncrementalMatchesFull(PY_SAMPLE, "python", steps);
  });

  test("markdown 语言(围栏内嵌套)与全量一致", () => {
    const md = "# title\n\n```js\nconst a = 1;\n```\n\n- item **bold**\n";
    const steps = [3, 10, 15, 22, 30, md.length];
    expectIncrementalMatchesFull(md, "markdown", steps);
  });

  test("空串与无换行单行", () => {
    expectIncrementalMatchesFull("const x = 1;", "tsx", [0, 1, 5, 12]);
  });

  test("连续空行边界(提交空 chunk 的状态推进)", () => {
    const code = "const a = 1;\n\n\nconst b = 2;\n";
    const steps = [12, 13, 14, 15, 20, code.length];
    expectIncrementalMatchesFull(code, "tsx", steps);
  });

  test("非追加变化(回退/编辑)重置后仍与全量一致", () => {
    const tokenizer = createStreamingTokenizer(highlighter, "tsx", THEMES);
    const first = tokenizer.tokenize("const a = 1;\nconst b = 2;\n");
    expect(first.wasFullTokenize).toBe(true);
    // 回退成不同内容
    const edited = "let z = 'other';\nconst c = 3;";
    const { result, wasFullTokenize } = tokenizer.tokenize(edited);
    expect(wasFullTokenize).toBe(true);
    expect(renderShape(result.tokens)).toBe(renderShape(fullTokenize(edited, "tsx").tokens));
    // 之后继续追加,回到增量路径
    const grown = edited + "\nconst d = 4;";
    const second = tokenizer.tokenize(grown);
    expect(second.wasFullTokenize).toBe(false);
    expect(renderShape(second.result.tokens)).toBe(renderShape(fullTokenize(grown, "tsx").tokens));
  });

  test("CRLF 内容走全量路径且结果与全量一致", () => {
    const crlf = "const a = 1;\r\n\r\nconst b = 2;\r\n";
    const tokenizer = createStreamingTokenizer(highlighter, "tsx", THEMES);
    const { result, wasFullTokenize } = tokenizer.tokenize(crlf);
    expect(wasFullTokenize).toBe(true);
    expect(renderShape(result.tokens)).toBe(renderShape(fullTokenize(crlf, "tsx").tokens));
    // CRLF 后追加:仍全量,仍一致
    const grown = crlf + "const c = 3;";
    const next = tokenizer.tokenize(grown);
    expect(next.wasFullTokenize).toBe(true);
    expect(renderShape(next.result.tokens)).toBe(renderShape(fullTokenize(grown, "tsx").tokens));
  });

  test("同一内容重复调用幂等(StrictMode 双调用防护)", () => {
    const tokenizer = createStreamingTokenizer(highlighter, "tsx", THEMES);
    const code = "const a = `open\ntemplate";
    const r1 = tokenizer.tokenize(code);
    const r2 = tokenizer.tokenize(code);
    expect(renderShape(r1.result.tokens)).toBe(renderShape(r2.result.tokens));
    expect(renderShape(r2.result.tokens)).toBe(renderShape(fullTokenize(code, "tsx").tokens));
  });
});
