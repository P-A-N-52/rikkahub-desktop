// 漂移防线:PI_COMPACTION_PROMPT 是 vendor 私有常量的展示副本("pi/ 只跟上游"纪律
// 禁止改 vendor 加 export)。本测试在测试期读 vendor 源文件逐字对比——pi 升级改动
// SUMMARIZATION_PROMPT 时本测试变红,提醒同步副本(pi-engine/compaction-prompt-text.ts)。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PI_COMPACTION_PROMPT } from "./compaction-prompt-text";

describe("pi 压缩 prompt 展示副本与 vendor 源一致", () => {
  test("SUMMARIZATION_PROMPT 逐字一致(vendor 升级漂移时本测试红,同步副本后转绿)", async () => {
    const vendorPath = join(
      import.meta.dir,
      "../../pi/packages/coding-agent/src/core/compaction/compaction.ts",
    );
    const source = await Bun.file(vendorPath).text();
    // vendor 内 prompt 是模板字面量且不含反引号/插值,非贪婪提取到下一个反引号即整段。
    const match = source.match(/const SUMMARIZATION_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    expect(PI_COMPACTION_PROMPT).toBe(match![1]!);
  });
});
