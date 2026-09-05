// 压缩边界展示面判定(lib/compaction.ts)——分割线位置的数据契约。
import { describe, expect, it } from "bun:test";

import { effectiveCompactionCutId, isCompressionSummaryMessage } from "~/lib/compaction";

describe("effectiveCompactionCutId", () => {
  const present = new Set(["m1", "m2", "m3"]);

  it("取切点消息仍存在的最新一条记录", () => {
    const records = [
      { cutMessageId: "m1", summary: "旧", tokensBefore: 1 },
      { cutMessageId: "m3", summary: "新", tokensBefore: 2 },
    ];
    expect(effectiveCompactionCutId(records, present)).toBe("m3");
  });

  it("最新记录的切点消息已不存在时回退到更早记录", () => {
    const records = [
      { cutMessageId: "m2", summary: "旧", tokensBefore: 1 },
      { cutMessageId: "gone", summary: "新", tokensBefore: 2 },
    ];
    expect(effectiveCompactionCutId(records, present)).toBe("m2");
  });

  it("非数组/空数组/脏记录一律返回 null,不炸", () => {
    expect(effectiveCompactionCutId(undefined, present)).toBeNull();
    expect(effectiveCompactionCutId(null, present)).toBeNull();
    expect(effectiveCompactionCutId([], present)).toBeNull();
    expect(effectiveCompactionCutId([null, "junk", { noCut: true }, { cutMessageId: 42 }], present)).toBeNull();
  });
});

describe("isCompressionSummaryMessage", () => {
  it("按注解判别,缺 annotations 容忍", () => {
    expect(
      isCompressionSummaryMessage({ annotations: [{ type: "compression_summary" }] }),
    ).toBe(true);
    expect(
      isCompressionSummaryMessage({ annotations: [{ type: "model_call_error", message: "x" }] }),
    ).toBe(false);
    expect(isCompressionSummaryMessage({ annotations: [] })).toBe(false);
    expect(
      isCompressionSummaryMessage({ annotations: undefined as unknown as [] }),
    ).toBe(false);
  });
});
