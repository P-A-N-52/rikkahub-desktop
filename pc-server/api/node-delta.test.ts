// 专题2 H-b 单测:流式节点帧增量判定的正确性契约。
// 核心不变量:diffFingerprints 返回非 null 时,客户端"prev 状态 + deltas"必须能精确
// 重建 cur 状态;任何无法用纯文本追加表达的变化必须返回 null(退回全量关键帧)。
import { describe, expect, test } from "bun:test";

import { diffFingerprints, fingerprintNode } from "./node-delta";
import { message } from "../foundation/utils";
import type { MessageNode, MessagePart } from "../foundation/types";

function node(parts: MessagePart[], extra?: Partial<MessageNode>): MessageNode {
  const msg = message("ASSISTANT", parts);
  msg.id = "m1";
  return { id: "n1", messages: [msg], selectIndex: 0, ...extra };
}

/** 深拷贝构造"下一帧"节点,避免测试里共享可变引用。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("fingerprintNode", () => {
  test("选中 message 缺失 → null(永远走关键帧)", () => {
    const n = node([{ type: "text", text: "a" }]);
    n.selectIndex = 5;
    expect(fingerprintNode(n)).toBeNull();
  });

  test("text/reasoning 走字符串通道,其余 part 走 JSON 指纹", () => {
    const fp = fingerprintNode(
      node([
        { type: "text", text: "hello" },
        { type: "reasoning", reasoning: "think", createdAt: "t0" },
        { type: "image", url: "u", metadata: {} },
      ]),
    )!;
    expect(fp.parts.map((p) => p.kind)).toEqual(["string", "string", "json"]);
  });
});

describe("diffFingerprints", () => {
  test("纯文本前缀增长 → 增量列表", () => {
    const a = node([{ type: "text", text: "你好" }]);
    const b = clone(a);
    (b.messages[0]!.parts[0] as { text: string }).text = "你好世界";
    const deltas = diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)!;
    expect(deltas).toEqual([{ partIndex: 0, baseLen: 2, text: "世界" }]);
  });

  test("text 与 reasoning 同帧各自增长 → 两条增量", () => {
    const a = node([
      { type: "reasoning", reasoning: "想", createdAt: "t0" },
      { type: "text", text: "答" },
    ]);
    const b = clone(a);
    (b.messages[0]!.parts[0] as { reasoning: string }).reasoning = "想了想";
    (b.messages[0]!.parts[1] as { text: string }).text = "答案";
    const deltas = diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)!;
    expect(deltas).toEqual([
      { partIndex: 0, baseLen: 1, text: "了想" },
      { partIndex: 1, baseLen: 1, text: "案" },
    ]);
  });

  test("完全一致 → 空列表(可不发帧)", () => {
    const a = node([{ type: "text", text: "same" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(clone(a))!)).toEqual([]);
  });

  test("part 数量变化(新增 part)→ null", () => {
    const a = node([{ type: "text", text: "a" }]);
    const b = node([{ type: "text", text: "a" }, { type: "text", text: "" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("part 类型变化 → null", () => {
    const a = node([{ type: "reasoning", reasoning: "x" }]);
    const b = node([{ type: "text", text: "x" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("非前缀变化(文本被改写/回退)→ null", () => {
    const a = node([{ type: "text", text: "hello world" }]);
    const b = node([{ type: "text", text: "hello earth" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
    const c = node([{ type: "text", text: "hello" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(c)!)).toBeNull();
  });

  test("reasoning 元字段变化(finishedAt)→ null,即使文本只增不减", () => {
    const a = node([{ type: "reasoning", reasoning: "想", createdAt: "t0", finishedAt: null }]);
    const b = node([{ type: "reasoning", reasoning: "想完了", createdAt: "t0", finishedAt: "t1" }]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("工具 part 输入/输出变化 → null", () => {
    const tool = { type: "tool", toolCallId: "c1", toolName: "search", input: { q: "a" }, output: [] } as unknown as MessagePart;
    const a = node([{ type: "text", text: "t" }, tool]);
    const b = clone(a);
    (b.messages[0]!.parts[1] as unknown as { input: object }).input = { q: "ab" };
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("tool 单 text 输出前缀增长 → 增量(M2-2 bash 流式)", () => {
    const tool = {
      type: "tool", toolCallId: "c1", toolName: "bash", input: { command: "ls" },
      output: [{ type: "text", text: "first\n" }], approvalState: { type: "auto" },
    } as unknown as MessagePart;
    const a = node([tool]);
    const b = clone(a);
    ((b.messages[0]!.parts[0] as unknown as { output: [{ text: string }] }).output[0]).text += "second\n";
    const deltas = diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)!;
    expect(deltas).toEqual([{ partIndex: 0, baseLen: 6, text: "second\n" }]);
  });

  test("tool 输出条目 metadata 变化(截断后挂 details)→ null", () => {
    const tool = {
      type: "tool", toolCallId: "c1", toolName: "bash", input: {},
      output: [{ type: "text", text: "x" }], approvalState: { type: "auto" },
    } as unknown as MessagePart;
    const a = node([tool]);
    const b = clone(a);
    const entry = (b.messages[0]!.parts[0] as unknown as { output: [{ text: string; metadata?: object }] }).output[0];
    entry.text += "y";
    entry.metadata = { workspace: { tool: "bash", details: { exitCode: 0 } } };
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("tool 输出从空变单条目(建卡→首帧)→ null(kind 变化回退关键帧)", () => {
    const mk = (output: unknown[]) => ({
      type: "tool", toolCallId: "c1", toolName: "bash", input: {}, output, approvalState: { type: "auto" },
    }) as unknown as MessagePart;
    const a = node([mk([])]);
    const b = node([mk([{ type: "text", text: "hi" }])]);
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("message 增加(regenerate 新分支)→ null", () => {
    const a = node([{ type: "text", text: "t" }]);
    const b = clone(a);
    const second = message("ASSISTANT", [{ type: "text", text: "" }]);
    second.id = "m2";
    b.messages.push(second);
    b.selectIndex = 1;
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("selectIndex 变化 → null", () => {
    const msg2 = message("ASSISTANT", [{ type: "text", text: "alt" }]);
    msg2.id = "m2";
    const a = node([{ type: "text", text: "t" }]);
    a.messages.push(msg2);
    const b = clone(a);
    b.selectIndex = 1;
    expect(diffFingerprints(fingerprintNode(a)!, fingerprintNode(b)!)).toBeNull();
  });

  test("重建不变量:随机追加序列下 prev+deltas 恰好等于 cur", () => {
    let cur = node([
      { type: "reasoning", reasoning: "", createdAt: "t0" },
      { type: "text", text: "" },
    ]);
    const chunks = ["流", "式输", "出的每", "一段增量", "都必须可重建"];
    for (const chunk of chunks) {
      const next = clone(cur);
      (next.messages[0]!.parts[0] as { reasoning: string }).reasoning += chunk;
      (next.messages[0]!.parts[1] as { text: string }).text += chunk.split("").reverse().join("");
      const deltas = diffFingerprints(fingerprintNode(cur)!, fingerprintNode(next)!)!;
      expect(deltas).not.toBeNull();
      // 模拟客户端应用
      const rebuilt = clone(cur);
      for (const d of deltas) {
        const part = rebuilt.messages[0]!.parts[d.partIndex]! as { text?: string; reasoning?: string; type: string };
        const field = part.type === "text" ? "text" : "reasoning";
        expect((part[field as "text"] ?? "").length).toBe(d.baseLen);
        part[field as "text"] = (part[field as "text"] ?? "") + d.text;
      }
      expect(rebuilt).toEqual(next);
      cur = next;
    }
  });
});
