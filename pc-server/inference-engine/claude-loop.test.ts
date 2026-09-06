// Claude 流式工具循环端到端单测（P1-5 批B）：mock 全局 fetch 仿真 Anthropic SSE，
// 验证 thinking signature 回放、tool_result 编码、工具分发、最终文本——这是 Claude
// 路径唯一的回归网（request-chain smoke 只覆盖 OpenAI）。
import { afterAll, describe, expect, mock, test } from "bun:test";

// 展开真实模块只覆盖目标导出:bun 的 mock.module 跨测试文件不回收(见 tool-loop.test.ts)。
import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { streamClaudeChatWithTools } = await import("./providers");

const assistant = { id: "a1", mcpServers: [] } as never;
const providerItem = { id: "p1", name: "Claude Test" } as never;

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const toolRoundStream = sse([
  ["message_start", { message: { usage: { input_tokens: 10 } } }],
  ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "思考中" } }],
  ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig123" } }],
  ["content_block_stop", { index: 0 }],
  ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "do_it" } }],
  ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }],
  ["content_block_stop", { index: 1 }],
  ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
  ["message_stop", {}],
]);

const finalRoundStream = sse([
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "完成" } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
  ["message_stop", {}],
]);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("streamClaudeChatWithTools", () => {
  test("工具轮→tool_result 回放(thinking signature 保留)→最终文本", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const streams = [toolRoundStream, finalRoundStream];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)));
      return new Response(streams.shift() ?? "", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const events: Array<Record<string, unknown>> = [];
    const executed: Array<{ name: string; args: string }> = [];
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
      executeTool: async (call: { function: { name: string; arguments: string } }) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return { output: [{ type: "text", text: "工具输出" }] };
      },
    } as never;

    const out = await streamClaudeChatWithTools(
      "https://api.test/v1/messages",
      { "x-api-key": "k" },
      { model: "claude-test", messages: [{ role: "user", content: "hi" }] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );

    expect(out).toBe("完成");
    expect(executed).toEqual([{ name: "do_it", args: '{"a":1}' }]);

    // 第二轮请求体：assistant 回放轮(thinking+signature 与 tool_use)+ user tool_result 轮
    expect(requestBodies).toHaveLength(2);
    const secondMessages = requestBodies[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(secondMessages).toHaveLength(3);
    const assistantReplay = secondMessages[1]!;
    expect(assistantReplay.role).toBe("assistant");
    const replayBlocks = assistantReplay.content as Array<Record<string, unknown>>;
    // 现状(切换前旧实现同):thinking_delta 只累积进 thinkingOut 不写回 block,回放的
    // thinking 恒为 content_block_start 快照(通常空);signature 才是 Anthropic 的校验关键。
    expect(replayBlocks.find((b) => b.type === "thinking")).toEqual({ type: "thinking", thinking: "", signature: "sig123" });
    const toolUseReplay = replayBlocks.find((b) => b.type === "tool_use")!;
    expect(toolUseReplay.id).toBe("toolu_1");
    expect(toolUseReplay.name).toBe("do_it");
    const toolResultTurn = secondMessages[2]!;
    expect(toolResultTurn.role).toBe("user");
    const resultBlocks = toolResultTurn.content as Array<Record<string, unknown>>;
    expect(resultBlocks[0]!.type).toBe("tool_result");
    expect(resultBlocks[0]!.tool_use_id).toBe("toolu_1");

    // sink 事件链：thinking 增量、工具卡创建、工具输入增量、工具结果、usage、最终文本
    expect(events.some((e) => e.kind === "reasoning_delta" && e.text === "思考中")).toBe(true);
    expect(events.some((e) => e.kind === "tool_call_created" && e.toolCallId === "toolu_1")).toBe(true);
    expect(events.some((e) => e.kind === "tool_result" && e.toolCallId === "toolu_1")).toBe(true);
    expect(events.some((e) => e.kind === "usage")).toBe(true);
    expect(events.some((e) => e.kind === "text_delta" && e.text === "完成")).toBe(true);
  });

  test("无工具单轮直接返回文本", async () => {
    globalThis.fetch = (async () => new Response(finalRoundStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async () => ({ output: [] }),
    } as never;
    const out = await streamClaudeChatWithTools(
      "https://api.test/v1/messages",
      {},
      { model: "m", messages: [] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );
    expect(out).toBe("完成");
  });

  // 全面审查 3-1 回归:流内 error 事件(overloaded/rate_limit 等)必须穿透 SSE 容错
  // catch 冒泡成拒绝。原缺陷:catch 用 message.startsWith("Claude stream error") 判别,
  // 真实 API 错误文案(如 "Overloaded")不带该前缀 → 被当 malformed fragment 吞掉,
  // 残缺回答被当正常完成落库。
  test("流内 error 事件冒泡为拒绝,不被容错 catch 吞掉", async () => {
    const errorStream = sse([
      ["message_start", { message: { usage: { input_tokens: 4 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "开头" } }],
      ["error", { error: { type: "overloaded_error", message: "Overloaded" } }],
    ]);
    globalThis.fetch = (async () => new Response(errorStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async () => ({ output: [] }),
    } as never;
    await expect(
      streamClaudeChatWithTools("https://api.test/v1/messages", {}, { model: "m", messages: [] }, providerItem, assistant, undefined, hooks),
    ).rejects.toThrow("Overloaded");
  });
});

// 专题9:助手关闭"流式输出"→ 全程非流式 JSON(对齐安卓 GenerationHandler stream=assistant.streamOutput)。
describe("streamClaudeChatWithTools 非流式模式", () => {
  const nsAssistant = { id: "a1", mcpServers: [], streamOutput: false } as never;
  const toolRoundJson = JSON.stringify({
    content: [
      { type: "thinking", thinking: "思考中", signature: "sig123" },
      { type: "tool_use", id: "toolu_1", name: "do_it", input: { a: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const finalRoundJson = JSON.stringify({
    content: [{ type: "text", text: "完成" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 3 },
  });

  test("两轮均 stream:false;JSON 解析出思维链/工具/文本;原生 block 回放保留 signature", async () => {
    const requests: Array<{ body: Record<string, unknown>; accept: string | undefined }> = [];
    const payloads = [toolRoundJson, finalRoundJson];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({ body: JSON.parse(String(init.body)), accept: headers.Accept });
      return new Response(payloads.shift() ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const events: Array<Record<string, unknown>> = [];
    const executed: Array<{ name: string; args: string }> = [];
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
      executeTool: async (call: { function: { name: string; arguments: string } }) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return { output: [{ type: "text", text: "工具输出" }] };
      },
    } as never;

    const out = await streamClaudeChatWithTools(
      "https://api.test/v1/messages",
      { "x-api-key": "k" },
      { model: "claude-test", messages: [{ role: "user", content: "hi" }] },
      providerItem,
      nsAssistant,
      undefined,
      hooks,
    );

    expect(out).toBe("完成");
    expect(executed).toEqual([{ name: "do_it", args: JSON.stringify({ a: 1 }) }]);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.body.stream === false)).toBe(true);
    expect(requests.every((r) => r.accept !== "text/event-stream")).toBe(true);

    // 回放:非流式拿到的是原生 content blocks,thinking 全文与 signature 一并保留
    const secondMessages = requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    const replayBlocks = secondMessages[1]!.content as Array<Record<string, unknown>>;
    expect(replayBlocks.find((b) => b.type === "thinking")).toEqual({ type: "thinking", thinking: "思考中", signature: "sig123" });
    expect(replayBlocks.find((b) => b.type === "tool_use")!.id).toBe("toolu_1");

    expect(events.some((e) => e.kind === "reasoning_delta" && e.text === "思考中")).toBe(true);
    expect(events.some((e) => e.kind === "tool_call_created" && e.toolCallId === "toolu_1")).toBe(true);
    expect(events.some((e) => e.kind === "usage")).toBe(true);
    expect(events.some((e) => e.kind === "text_delta" && e.text === "完成")).toBe(true);
  });
});

// 内测两连反馈(Kimi TPS≈0)的最终根因回归:anthropic 语义里 message_start.usage.
// output_tokens 是起始计数(常为 1),最终值只来自 message_delta。Kimi coding 等兼容
// 端点 message_delta 不带 usage——若把起始值当真,completionTokens 恒 1,ensureUsage
// 字段级估算兜底被非零值挡住,TPS 显示≈0。
describe("readClaudeStreamingRound:message_start 不吸收 output_tokens", () => {
  async function runRound(events: Array<[string, unknown]>) {
    const { readClaudeStreamingRound } = await import("./providers");
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
    } as never;
    const response = new Response(sse(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    return readClaudeStreamingRound(response, hooks, assistant);
  }

  test("兼容端点(message_delta 无 usage):completion 保持 0,交给估算兜底;input 侧照常吸收", async () => {
    const round = await runRound([
      ["message_start", { message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "回答正文" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn" } }],
      ["message_stop", {}],
    ]);
    const usage = round.usage as Record<string, number>;
    expect(usage.completionTokens).toBe(0);
    expect(usage.promptTokens).toBe(120);
    expect(usage.cachedTokens).toBe(20);
  });

  test("官方端点回归:message_delta 的最终 output_tokens 正常覆盖", async () => {
    const round = await runRound([
      ["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 520 } }],
      ["message_stop", {}],
    ]);
    expect((round.usage as Record<string, number>).completionTokens).toBe(520);
  });
});
