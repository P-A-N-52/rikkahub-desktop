// subprocess-engine/protocol.test.ts — 行切分与 JSON-RPC 解析的契约测试(T4)。
//
// 骨架的验证策略(方案 §六 T4):mock 一个子进程 stdout 流,验证行切分/协议解析/
// 事件桥产出正确结果。本文件锁 protocol.ts 的两个纯函数——createLineFramer(增量
// 行切分)与 parseJsonRpcLine(JSON-RPC 归类),不经真实子进程,快速且确定性。

import { describe, expect, test } from "bun:test";

import { createLineFramer, parseJsonRpcLine, MAX_LINE_BYTES, type FrameYield } from "./protocol";

const encoder = new TextEncoder();

function frameLines(frames: FrameYield[]): string[] {
  return frames.filter((f): f is Extract<FrameYield, { type: "line" }> => f.type === "line").map((f) => f.text);
}

describe("createLineFramer 行切分", () => {
  test("整行一次到位", () => {
    const frames: FrameYield[] = [];
    const framer = createLineFramer((f) => frames.push(f));
    framer.feed(encoder.encode('{"a":1}\n{"b":2}\n'));
    framer.flush();
    expect(frameLines(frames)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("跨 chunk 的半行被攒起,到齐才成行", () => {
    const frames: FrameYield[] = [];
    const framer = createLineFramer((f) => frames.push(f));
    framer.feed(encoder.encode('{"he'));
    expect(frames).toHaveLength(0); // 半行不上交
    framer.feed(encoder.encode('llo"}\nnext'));
    framer.flush();
    expect(frameLines(frames)).toEqual(['{"hello"}', "next"]);
  });

  test("CRLF 与 LF 都认(Windows 子进程)", () => {
    const frames: FrameYield[] = [];
    const framer = createLineFramer((f) => frames.push(f));
    framer.feed(encoder.encode("a\r\nb\nc\r\n"));
    framer.flush();
    expect(frameLines(frames)).toEqual(["a", "b", "c"]);
  });

  test("空行被丢弃,残行在 flush 时冲出", () => {
    const frames: FrameYield[] = [];
    const framer = createLineFramer((f) => frames.push(f));
    framer.feed(encoder.encode("\n\nlast-no-newline"));
    framer.flush();
    expect(frameLines(frames)).toEqual(["last-no-newline"]);
  });

  test("单行超防卫上限判协议违例,后续帧不再处理", () => {
    const frames: FrameYield[] = [];
    const framer = createLineFramer((f) => frames.push(f));
    framer.feed(encoder.encode("x".repeat(MAX_LINE_BYTES + 1)));
    const violations = frames.filter((f) => f.type === "violation");
    expect(violations).toHaveLength(1);
    expect(framer.violated).toBe(true);
    frames.length = 0;
    framer.feed(encoder.encode("more\n"));
    expect(frames).toHaveLength(0); // 违例后停摆
  });
});

describe("parseJsonRpcLine JSON-RPC 归类", () => {
  test("request:有 id 有 method", () => {
    const outcome = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"approve","params":{"x":1}}');
    expect(outcome).toEqual({ ok: true, message: { kind: "request", id: 1, method: "approve", params: { x: 1 } } });
  });

  test("response:有 id 无 method(result)", () => {
    const outcome = parseJsonRpcLine('{"jsonrpc":"2.0","id":"abc","result":{"ok":true}}');
    expect(outcome).toEqual({ ok: true, message: { kind: "response", id: "abc", result: { ok: true }, error: undefined } });
  });

  test("response:有 id 无 method(error)", () => {
    const outcome = parseJsonRpcLine('{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"boom"}}');
    expect(outcome.ok && outcome.message.kind === "response" && outcome.message.error?.message).toBe("boom");
  });

  test("notification:有 method 无 id", () => {
    const outcome = parseJsonRpcLine('{"jsonrpc":"2.0","method":"delta","params":{"text":"hi"}}');
    expect(outcome).toEqual({ ok: true, message: { kind: "notification", method: "delta", params: { text: "hi" } } });
  });

  test("非 JSON 行(子进程日志)→ ok:false 不抛", () => {
    const outcome = parseJsonRpcLine("[info] starting up...");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("非 JSON");
  });

  test("既无 id 也无 method → ok:false", () => {
    const outcome = parseJsonRpcLine('{"foo":1}');
    expect(outcome.ok).toBe(false);
  });
});
