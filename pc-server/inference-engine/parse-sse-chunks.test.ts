// parseSseChunks 单测(批次六 R3-7):SSE 规范允许一个事件的 data 跨多行,join 后才是
// 完整载荷。回归点:跨行 JSON 此前被无条件按行再拆,每行解析失败被调用方容错吞掉,
// 内容整段静默丢失;单行载荷与"同一 block 塞多个单行 JSON 事件"的不规范上游行为不变。
import { describe, expect, test } from "bun:test";

import { parseSseChunks } from "./providers";

describe("parseSseChunks", () => {
  test("单行 data:逐块解析,行为不变", () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("[DONE] 原样透传", () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', "[DONE]"]);
  });

  test("跨行 data(美化 JSON):join 后整体返回,可被 JSON.parse", () => {
    const pretty = '{\n  "choices": [\n    {"delta": {"content": "hi"}}\n  ]\n}';
    const text = pretty.split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n";
    const chunks = parseSseChunks(text);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toEqual({ choices: [{ delta: { content: "hi" } }] });
  });

  test("同一 block 多个单行 JSON 事件(不规范上游):退回逐行拆分", () => {
    const text = 'data: {"a":1}\ndata: {"b":2}\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("CRLF 事件分隔(\\r\\n\\r\\n,HTTP 规范允许):照常逐事件解析", () => {
    // 内测反馈(Kimi 流式卡顿排查)回归:旧 /\n\n+/ 对 CRLF 流整段切不开,
    // 全部内容攒到流结束才兜底解析(表现为"停住→哗啦一大段")。
    const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\ndata: [DONE]\r\n\r\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });
});

describe("readOpenAiStream 读循环分帧(CRLF 回归)", () => {
  test("CRLF 上游逐事件即时产出,不攒到流尾", async () => {
    // 门闩机制:第一个事件必须在流未结束时就被解析并回调,才会放行第二个 chunk。
    // 若回归为"攒 buffer 到流尾",gate 永不放行 → 用例超时失败,信号明确。
    const { readOpenAiStream } = await import("./providers");
    const arrived: string[] = [];
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\r\n\r\n'));
        await gate;
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第二段"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'));
        controller.close();
      },
    });
    await readOpenAiStream(new Response(stream), (delta: { content?: string }) => {
      if (typeof delta?.content === "string" && delta.content) {
        arrived.push(delta.content);
        releaseSecond();
      }
    });
    expect(arrived).toEqual(["第一段", "第二段"]);
  }, 10_000);

  test("CRLF 分隔与空 data 行过滤", () => {
    const text = 'data: {"a":1}\r\ndata:\r\n\r\n\r\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}']);
  });
});
