// Responses API 工具续传回归（2026-09-05 内测报障）：流按 output_index 建槽，思考
// 模型（GLM-5.3@火山 plan 端点等）的 reasoning 项占 0 号槽，function_call 从 1 号
// 起——replay 原始数组带洞，曾被直接拼进续传 input，洞经 JSON.stringify 变 null 项，
// 火山严格校验 400（MissingParameter input.role）。encodeNextTurn 必须用归一化密集
// 数组（readRound 已过滤洞/无名并给缺失 id 兜底，与 output 项 call_id 同源配对）。
// mock.module 纪律同 tool-loop.test.ts：展开真实模块只覆盖目标导出。
import { describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { fetchOpenAiTextStreaming, responseApiToolCallItems } = await import("./providers");

function sse(frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Responses API 工具续传（火山 input.role 400 回归）", () => {
  test("reasoning 占槽的稀疏洞不得进续传 input（无 null 项），call_id 与 output 项配对", async () => {
    const captured: Array<Record<string, any>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")));
      if (captured.length === 1) {
        // 第一轮：reasoning 项占 output_index 0，function_call 在 1 号槽（真实报障形态）。
        return sse([
          JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "function_call", call_id: "call_a", name: "lookup", arguments: '{"q":1}' },
          }),
          "[DONE]",
        ]);
      }
      return sse([JSON.stringify({ type: "response.output_text.delta", delta: "done" }), "[DONE]"]);
    }) as never;
    try {
      const hooks = {
        conversation: { id: "c1", title: "t" },
        node: { id: "n1" },
        message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
        sink: () => {},
        executeTool: async () => ({ output: [{ type: "text", text: "ok" }] }),
      } as never;
      const text = await fetchOpenAiTextStreaming(
        "https://ark.example/api/plan/v3/responses",
        { "Content-Type": "application/json" },
        { model: "glm-5-3-flash", stream: true, input: [{ role: "user", content: "hi" }] },
        { id: "p1", name: "火山引擎", type: "openai" } as never,
        { id: "a1", mcpServers: [] } as never,
        hooks,
      );
      expect(text).toBe("done");
      expect(captured.length).toBe(2);
      const input = captured[1].input as unknown[];
      // 根因回归：稀疏洞序列化产物是 null 项——一个都不能有。
      expect(input.some((item) => item == null)).toBe(false);
      const functionCall = input.find((item: any) => item?.type === "function_call") as Record<string, unknown>;
      const functionOutput = input.find((item: any) => item?.type === "function_call_output") as Record<string, unknown>;
      expect(functionCall).toMatchObject({ call_id: "call_a", name: "lookup", arguments: '{"q":1}' });
      expect(functionOutput?.call_id).toBe("call_a");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("responseApiToolCallItems：归一化密集数组 → 标准 function_call 回放项", () => {
    expect(responseApiToolCallItems([{ id: "c1", name: "t", arguments: "{}" }])).toEqual([
      { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
    ]);
  });
});
