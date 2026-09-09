// 流式工具续传回放纪律回归（2026-09-05 内测报障 + 同类加固）：流式 toolCalls 按
// index/output_index 建槽是潜在稀疏数组，encodeNextTurn 两分支（Responses input /
// chat-completions messages）必须消费归一化密集数组——洞经 JSON.stringify 变 null
// 项，火山等严格端点 400（MissingParameter input.role）。报障场景：GLM-5.3@火山
// plan /responses 端点，reasoning 项占 0 号槽，function_call 从 1 号起。
// 2026-09-07 追加：Responses 的 function_call 有两个 id（item.id=fc_… 条目 id /
// item.call_id=call_… 调用配对 id），参数帧只带 item_id ——误取会把建槽 id 从 call_
// 改写成 fc_，一次调用落库两张卡、空参卡进第二问历史即 400 input.arguments。
// mock.module 纪律同 tool-loop.test.ts：展开真实模块只覆盖目标导出。
import { describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { fetchOpenAiTextStreaming, responseApiToolCallItems, responseEventToDelta } = await import("./providers");

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

  // ── 2026-09-07 内测报障：第二问必炸 MissingParameter input.arguments ──────────
  // Responses 的 function_call 带两个语义不同的 id（官方 OpenAPI FunctionToolCall）：
  //   item.id      = 输出【条目】id（fc_…，可选）
  //   item.call_id = 工具【调用】配对 id（call_…，必填，回传时必须用它）
  // 而 arguments.delta/done 两帧按 spec 只带 item_id（= fc_…）、无 call_id 字段。
  // 旧写法 `item_id ?? call_id` 把建槽 id 从 call_ 改写成 fc_，一次调用落库两张卡
  // （空参的 call_ 卡 + 有参的 fc_ 卡），空参卡进第二问历史编码即 400。
  describe("function_call 双 id 不得串台（第二问 input.arguments 400）", () => {
    test("responseEventToDelta：added 取 call_id；参数帧不得拿 item_id 当调用 id", () => {
      const added = responseEventToDelta({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
      }) as { tool_calls: Array<{ id: string }> };
      expect(added.tool_calls[0]!.id).toBe("call_1");

      for (const frame of [
        { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "{}" },
        { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: "{}" },
      ]) {
        const delta = responseEventToDelta(frame) as { tool_calls: Array<{ id: string }> };
        // 空串即"本帧无调用 id"，由 mergeToolCallDeltas 的真值判定保留已建槽的 call_id。
        expect(delta.tool_calls[0]!.id).toBe("");
      }
    });

    test("整链：官方双 id 形态只产一张卡，参数完整；续传与历史编码均无空参项", async () => {
      const captured: Array<Record<string, any>> = [];
      const created: Array<Record<string, unknown>> = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init: any) => {
        captured.push(JSON.parse(String(init?.body ?? "{}")));
        if (captured.length === 1) {
          return sse([
            JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
            JSON.stringify({
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
            }),
            // 参数帧只带 item_id（官方 spec 形态，无 call_id）。
            JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"q":' }),
            JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: '{"q":1}' }),
            "[DONE]",
          ]);
        }
        return sse([JSON.stringify({ type: "response.output_text.delta", delta: "done" }), "[DONE]"]);
      }) as never;
      try {
        const hooks = {
          conversation: { id: "c4", title: "t" },
          node: { id: "n1" },
          message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
          sink: (event: Record<string, unknown>) => {
            if (event.kind === "tool_call_created") created.push(event);
          },
          executeTool: async () => ({ output: [{ type: "text", text: "ok" }] }),
        } as never;
        await fetchOpenAiTextStreaming(
          "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
          { "Content-Type": "application/json" },
          { model: "deepseek-v4-flash", stream: true, input: [{ role: "user", content: "hi" }] },
          { id: "p1", name: "火山引擎", type: "openai" } as never,
          { id: "a1", mcpServers: [] } as never,
          hooks,
        );
        // 一次调用只建一张卡（旧行为：call_1 空参卡 + fc_1 有参卡＝两张）。
        expect([...new Set(created.map((event) => event.toolCallId))]).toEqual(["call_1"]);
        const input = captured[1].input as Array<Record<string, any>>;
        const calls = input.filter((item) => item?.type === "function_call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ call_id: "call_1", arguments: '{"q":1}' });
        // 空 arguments 是第二问 400 的直接触发物——回传体里一个都不许有。
        expect(calls.every((call) => String(call.arguments ?? "").trim().length > 0)).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  test("arguments.done 帧缺 item_id/call_id 时不得抹掉已建槽的 call_id；帧全程无 id 时归一化兜底非空", async () => {
    const captured: Array<Record<string, any>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")));
      if (captured.length === 1) {
        return sse([
          // 工具A：added 带 call_id，随后 done 帧无 item_id/call_id（id 归 ""）——
          // 旧 merge 用 ?? 判定，空串覆盖真 id，续传配对全空。
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", call_id: "call_real", name: "lookup", arguments: "" },
          }),
          JSON.stringify({ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"q":1}' }),
          // 工具B：全程无任何 id（劣质中转形态）——归一化必须兜底生成非空 id。
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "function_call", name: "lookup2", arguments: "" },
          }),
          JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: '{"q":2}' }),
          "[DONE]",
        ]);
      }
      return sse([JSON.stringify({ type: "response.output_text.delta", delta: "done" }), "[DONE]"]);
    }) as never;
    try {
      const hooks = {
        conversation: { id: "c3", title: "t" },
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
      const input = captured[1].input as Array<Record<string, any>>;
      const calls = input.filter((item) => item?.type === "function_call");
      const outputs = input.filter((item) => item?.type === "function_call_output");
      expect(calls).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      // 工具A：done 帧空 id 不覆盖 added 的真 call_id。
      expect(calls[0].call_id).toBe("call_real");
      // 工具B：兜底 id 非空，且 function_call 与 output 配对同源。
      expect(String(calls[1].call_id).length).toBeGreaterThan(0);
      expect(outputs.map((item) => item.call_id)).toEqual(calls.map((item) => item.call_id));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("chat-completions 续传同纪律：不规范中转 index 跳号建槽的洞不得进 tool_calls", async () => {
    const captured: Array<Record<string, any>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")));
      if (captured.length === 1) {
        // 不规范上游：唯一一个工具调用的 index 从 1 起（规范应为 0）——建槽产 0 号洞。
        return sse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "lookup", arguments: "{}" } }] } }],
          }),
          "[DONE]",
        ]);
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: "done" } }] }), "[DONE]"]);
    }) as never;
    try {
      const hooks = {
        conversation: { id: "c2", title: "t" },
        node: { id: "n1" },
        message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
        sink: () => {},
        executeTool: async () => ({ output: [{ type: "text", text: "ok" }] }),
      } as never;
      const text = await fetchOpenAiTextStreaming(
        "https://relay.example/v1/chat/completions",
        { "Content-Type": "application/json" },
        { model: "any-model", stream: true, messages: [{ role: "user", content: "hi" }] },
        { id: "p2", name: "中转", type: "openai" } as never,
        { id: "a1", mcpServers: [] } as never,
        hooks,
      );
      expect(text).toBe("done");
      const assistantTurn = (captured[1].messages as Array<Record<string, any>>).find((m) => m.role === "assistant" && m.tool_calls);
      const toolCalls = assistantTurn?.tool_calls as unknown[];
      expect(toolCalls.some((call) => call == null)).toBe(false);
      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as Record<string, any>).id).toBe("call_b");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
