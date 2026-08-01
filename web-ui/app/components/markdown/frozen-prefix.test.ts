// 流式前缀冻结的纯函数契约:晋升/回看/清零/幂等。渲染级不变式(前缀+尾部与整文
// 渲染一致)见 markdown-streaming.test.tsx。
import { describe, expect, test } from "bun:test";

import {
  advanceFrozenPrefix,
  EMPTY_FROZEN_PREFIX,
  STREAM_PROMOTE_HOLDBACK_BLOCKS,
  STREAM_PROMOTE_RETRY_GROWTH,
  STREAM_TAIL_PROMOTE_THRESHOLD,
  tailRenderIntervalMs,
} from "./frozen-prefix";

const identity = (s: string) => s;
const paragraphs = (n: number, size = 400) =>
  Array.from({ length: n }, (_, i) => `第${i}段 ${"字".repeat(size)}`).join("\n\n");

describe("advanceFrozenPrefix", () => {
  test("尾部未超阈值不晋升", () => {
    const content = "短".repeat(STREAM_TAIL_PROMOTE_THRESHOLD - 10);
    expect(advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity)).toBe(EMPTY_FROZEN_PREFIX);
  });

  test("超阈值晋升完整块;生长中的末块(及其空行分隔)永不晋升", () => {
    const content = paragraphs(10);
    const next = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity);
    expect(next.raw.length).toBeGreaterThan(0);
    expect(content.startsWith(next.raw)).toBe(true);
    // marked 把空行当独立 space token:回看 HOLDBACK=2 块 =「空行 + 生长中的末段」。
    // 末段必须留在活动尾部,且尾部以空行分隔符开头(晋升的内容块已被空行封口)。
    const tail = content.slice(next.raw.length);
    expect(tail).toContain("第9段");
    expect(next.raw).not.toContain("第9段");
    expect(tail.startsWith("\n\n")).toBe(true);
  });

  test("幂等:同一 content 重复推进结果不变(StrictMode 双调安全)", () => {
    const content = paragraphs(10);
    const once = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity);
    const twice = advanceFrozenPrefix(once, content, identity);
    expect(twice).toEqual(once);
  });

  test("追加式增长:前缀单调扩张且始终是 content 字面前缀", () => {
    let prefix = EMPTY_FROZEN_PREFIX;
    let previousRawLength = 0;
    for (let n = 4; n <= 24; n += 4) {
      const content = paragraphs(n);
      prefix = advanceFrozenPrefix(prefix, content, identity);
      expect(content.startsWith(prefix.raw)).toBe(true);
      expect(prefix.raw.length).toBeGreaterThanOrEqual(previousRawLength);
      previousRawLength = prefix.raw.length;
    }
    expect(previousRawLength).toBeGreaterThan(0);
  });

  test("content 不再以前缀开头(重新生成)→ 清零重来,不残留旧前缀", () => {
    const first = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, paragraphs(10), identity);
    const regenerated = Array.from({ length: 10 }, (_, i) => `新${i}段 ${"新".repeat(400)}`).join(
      "\n\n",
    );
    const next = advanceFrozenPrefix(first, regenerated, identity);
    expect(regenerated.startsWith(next.raw)).toBe(true);
    expect(next.raw).not.toContain("第0段");
  });

  test("未闭合代码围栏是单块,永不被切进前缀", () => {
    const content = `${paragraphs(5)}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(400)}`;
    const next = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity);
    expect(next.raw).not.toContain("```");
    expect(content.slice(next.raw.length)).toContain("```ts");
  });

  test("流式表格是单块,整体留在活动尾部", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| 行${i} | 值${i} |`).join("\n");
    const content = `${paragraphs(5)}\n\n| 列A | 列B |\n| --- | --- |\n${rows}`;
    const next = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity);
    expect(next.raw).not.toContain("| 列A |");
    expect(content.slice(next.raw.length)).toContain("| 行199 |");
  });

  test("含脚注时整文单块(Streamdown 语义),不晋升且记录失败水位", () => {
    const content = `${paragraphs(10)}\n\n引用脚注[^1]\n\n[^1]: 脚注内容`;
    const next = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, content, identity);
    expect(next.raw).toBe("");
    expect(next.attemptedTailLength).toBe(content.length);
  });

  test("失败水位闸门:巨型单块尾部不逐帧重试块切分,涨够 RETRY_GROWTH 才再试", () => {
    // 单个未闭合围栏 = 永远切不出可晋升块的巨型尾部(流式表格同类)
    const fence = (lines: number) => `\`\`\`ts\n${"const x = 1;\n".repeat(lines)}`;
    const first = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, fence(400), identity);
    expect(first.raw).toBe("");
    expect(first.attemptedTailLength).toBeGreaterThan(0);
    // 小步增长(不足 RETRY_GROWTH):原对象直接返回 = 未做任何块切分
    const slightly = fence(400) + "y";
    expect(advanceFrozenPrefix(first, slightly, identity)).toBe(first);
    // 涨够 RETRY_GROWTH:重试并刷新失败水位
    const grown = fence(400 + Math.ceil(STREAM_PROMOTE_RETRY_GROWTH / 13) + 1);
    const retried = advanceFrozenPrefix(first, grown, identity);
    expect(retried.attemptedTailLength).toBe(grown.length);
  });

  test("晋升成功后失败水位复位", () => {
    const next = advanceFrozenPrefix(EMPTY_FROZEN_PREFIX, paragraphs(10), identity);
    expect(next.raw.length).toBeGreaterThan(0);
    expect(next.attemptedTailLength).toBe(0);
  });

  test("processed 是各晋升段预处理产物的累积", () => {
    const upper = (s: string) => s.replaceAll("字", "X");
    let prefix = EMPTY_FROZEN_PREFIX;
    prefix = advanceFrozenPrefix(prefix, paragraphs(10), upper);
    prefix = advanceFrozenPrefix(prefix, paragraphs(20), upper);
    expect(prefix.processed).toBe(upper(prefix.raw));
  });
});

describe("tailRenderIntervalMs(巨型尾部自适应节奏档位)", () => {
  test("小尾部逐帧(0),8KB/32KB 分档降频,档位单调不减", () => {
    expect(tailRenderIntervalMs(0)).toBe(0);
    expect(tailRenderIntervalMs(8 * 1024 - 1)).toBe(0);
    expect(tailRenderIntervalMs(8 * 1024)).toBe(160);
    expect(tailRenderIntervalMs(32 * 1024 - 1)).toBe(160);
    expect(tailRenderIntervalMs(32 * 1024)).toBe(320);
    expect(tailRenderIntervalMs(1024 * 1024)).toBe(320);
  });
});
