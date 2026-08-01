// OpenAI 系流内建卡单测（工具卡迟现修复，2026-08-01）：delta 模式下 id+name 齐备即发
// tool_call_created，后续参数增量发 tool_input_delta——write/edit 等长参数工具流式生成
// 参数期间用户能立即看到工具卡，而不是等整轮流读完才"突然出现"。snapshot（非流式/
// 回放）模式无实时窗口，仍由循环层建卡，不得重复宣告。
import { describe, expect, mock, test } from "bun:test";

// 展开真实模块只覆盖目标导出:bun 的 mock.module 跨测试文件不回收(见 tool-loop.test.ts)。
import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { applyOpenAiDelta } = await import("./providers");

const assistant = { id: "a1", mcpServers: [] } as never;

function hooksFixture() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    hooks: {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
    } as never,
  };
}

describe("OpenAI 流式即时建卡", () => {
  test("delta 模式:首个 id+name delta 发 tool_call_created,后续参数增量发 tool_input_delta(累积)", () => {
    const { hooks, events } = hooksFixture();
    const toolCalls: unknown[] = [];

    // 第一包:id+name+参数开头
    applyOpenAiDelta(
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":' } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );
    // 后续两包:纯参数增量(OpenAI 流式惯例,不再带 name)
    applyOpenAiDelta(
      { tool_calls: [{ index: 0, function: { arguments: '"a.txt","content":"' } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );
    applyOpenAiDelta(
      { tool_calls: [{ index: 0, function: { arguments: '……"}' } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );

    const created = events.filter((e) => e.kind === "tool_call_created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolCallId: "call_1", toolName: "write_file", input: '{"path":' });

    const inputDeltas = events.filter((e) => e.kind === "tool_input_delta");
    expect(inputDeltas).toHaveLength(2);
    // tool_input_delta 携带的是累积后的完整参数(协调器整体替换 input)
    expect(inputDeltas[1]).toMatchObject({ toolCallId: "call_1", input: '{"path":"a.txt","content":"……"}' });
  });

  test("delta 模式:并行多工具各自建卡一次", () => {
    const { hooks, events } = hooksFixture();
    const toolCalls: unknown[] = [];

    applyOpenAiDelta(
      {
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { index: 1, id: "call_b", type: "function", function: { name: "list_dir", arguments: "{}" } },
        ],
      },
      {},
      hooks,
      toolCalls,
      assistant,
    );
    applyOpenAiDelta(
      { tool_calls: [{ index: 0, function: { arguments: "" } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );

    const created = events.filter((e) => e.kind === "tool_call_created");
    expect(created.map((e) => e.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  test("snapshot 模式(非流式回放)不发流内建卡事件,由循环层建卡", () => {
    const { hooks, events } = hooksFixture();
    const toolCalls: unknown[] = [];

    applyOpenAiDelta(
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "do_it", arguments: "{}" } }] },
      { choices: [{ message: { content: "" } }] }, // isSnapshot
      hooks,
      toolCalls,
      assistant,
    );

    expect(events.filter((e) => e.kind === "tool_call_created")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "tool_input_delta")).toHaveLength(0);
  });

  test("name 未到齐前不宣告(避免空名卡),到齐后补宣告", () => {
    const { hooks, events } = hooksFixture();
    const toolCalls: unknown[] = [];

    // 个别中转站首包只带 id 不带 name
    applyOpenAiDelta(
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "", arguments: "" } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );
    expect(events.filter((e) => e.kind === "tool_call_created")).toHaveLength(0);

    applyOpenAiDelta(
      { tool_calls: [{ index: 0, function: { name: "do_it", arguments: "{}" } }] },
      {},
      hooks,
      toolCalls,
      assistant,
    );
    const created = events.filter((e) => e.kind === "tool_call_created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolCallId: "call_1", toolName: "do_it" });
  });
});
