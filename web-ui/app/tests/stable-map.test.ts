// 代码块流式重挂载回归(2026-07 修复):citation map 必须按内容比较、内容不变时
// 复用旧引用,否则流式期间引用逐帧变化会沿 components useMemo 把代码块整棵重挂载。
import { describe, expect, test } from "bun:test";

import { mapsShallowEqual } from "~/lib/stable-map";

describe("mapsShallowEqual", () => {
  test("同引用恒等", () => {
    const m = new Map([["a", 1]]);
    expect(mapsShallowEqual(m, m)).toBe(true);
  });

  test("不同引用、内容相同 → 相等(流式期间的常态)", () => {
    expect(
      mapsShallowEqual(
        new Map([
          ["1", "https://a.example"],
          ["s2", "https://b.example"],
        ]),
        new Map([
          ["1", "https://a.example"],
          ["s2", "https://b.example"],
        ]),
      ),
    ).toBe(true);
  });

  test("空 Map 相等", () => {
    expect(mapsShallowEqual(new Map(), new Map())).toBe(true);
  });

  test("值不同 → 不等", () => {
    expect(mapsShallowEqual(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
  });

  test("键集合不同 → 不等", () => {
    expect(mapsShallowEqual(new Map([["a", 1]]), new Map([["b", 1]]))).toBe(false);
    expect(
      mapsShallowEqual(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]])),
    ).toBe(false);
  });
});
