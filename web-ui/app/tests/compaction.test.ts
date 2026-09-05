// 压缩发生点展示面判定(lib/compaction.ts)——分割线锚点的数据契约。
import { describe, expect, it } from "bun:test";

import { isCompactionBoundaryMessage } from "~/lib/compaction";

describe("isCompactionBoundaryMessage", () => {
  it("按注解判别,缺 annotations 容忍", () => {
    expect(
      isCompactionBoundaryMessage({ annotations: [{ type: "compaction_boundary" }] }),
    ).toBe(true);
    expect(
      isCompactionBoundaryMessage({ annotations: [{ type: "model_call_error", message: "x" }] }),
    ).toBe(false);
    expect(isCompactionBoundaryMessage({ annotations: [] })).toBe(false);
    expect(
      isCompactionBoundaryMessage({ annotations: undefined as unknown as [] }),
    ).toBe(false);
  });
});
