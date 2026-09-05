// tool-loop 骨架单测（P1-5 批A + 批次三 R3-4）：轮次推进 / 工具分发 / pending bail / 超限 /
// 非流式降级 / 文本累积模式 / 建卡模式 / abort 检查(读流后 + 工具执行前,三家统一)。
// mock.module 隔离 addLog(写 state+落盘)与 touchStream(SSE)副作用。
// 注意:bun 的 mock.module 全局生效且跨测试文件不回收,必须展开真实模块只覆盖目标
// 导出,否则同一进程里后续加载 app-config/defaults 等会因缺 defaultRequestStats 而炸。
import { describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

const logged: unknown[] = [];
mock.module("../api/logs", () => ({ ...actualLogs, addLog: (entry: unknown) => logged.push(entry) }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { runStreamingToolLoop } = await import("./tool-loop");
type Adapter = Parameters<typeof runStreamingToolLoop>[0];
type Round = Awaited<ReturnType<Adapter["readRound"]>>;

const assistant = { id: "a1", mcpServers: [] } as never;

function okResponse(): Response {
  return new Response("", { status: 200 });
}

function hooksFixture(executeTool?: (call: { function: { name: string } }) => Promise<{ output: never[] }>) {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    hooks: {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
      executeTool: executeTool ?? (async () => ({ output: [] })),
    } as never,
  };
}

function baseAdapter(rounds: Round[]): Adapter {
  let call = 0;
  return {
    providerItem: { id: "p1", name: "TestProvider" } as never,
    logUrl: "http://test/chat",
    logHeaders: {},
    fetchRound: async () => okResponse(),
    readRound: async () => {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round;
    },
    encodeNextTurn: (result, toolResults) => ({ turn: call, resultCount: toolResults.length }),
    logResponseBody: () => "body",
    joinTextWithNewline: false,
    toolCardsCreatedInStream: true,
    finishReasoningOnFinal: false,
    exhaustedError: "exhausted",
    headerTimeoutMs: () => 0,
  };
}

const noTools = (text: string): Round => ({ text, toolCalls: [], replay: null });
const withTool = (text: string, name = "do_it"): Round => ({
  text,
  toolCalls: [{ id: "tc1", name, arguments: "{}" }],
  replay: null,
});

describe("轮次与返回值", () => {
  test("无工具单轮返回文本；空文本兜底 (empty response)", async () => {
    const { hooks } = hooksFixture();
    expect(await runStreamingToolLoop(baseAdapter([noTools("你好")]), {}, assistant, undefined, hooks)).toBe("你好");
    expect(await runStreamingToolLoop(baseAdapter([noTools("")]), {}, assistant, undefined, hooks)).toBe("(empty response)");
  });

  test("工具轮推进：执行工具→encodeNextTurn→下一轮文本返回；文本按模式累积", async () => {
    const executed: string[] = [];
    const { hooks, events } = hooksFixture(async (call) => {
      executed.push(call.function.name);
      return { output: [] };
    });
    const adapter = baseAdapter([withTool("第一轮"), noTools("第二轮")]);
    adapter.joinTextWithNewline = true;
    const encoded: unknown[] = [];
    const origEncode = adapter.encodeNextTurn;
    adapter.encodeNextTurn = (result, toolResults) => {
      encoded.push(toolResults.map((t) => t.call.id));
      return origEncode(result, toolResults);
    };
    const out = await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks);
    expect(out).toBe("第一轮\n第二轮");
    expect(executed).toEqual(["do_it"]);
    expect(encoded).toEqual([["tc1"]]);
    expect(events.some((e) => e.kind === "tool_result" && e.toolCallId === "tc1")).toBe(true);
  });

  test("OpenAI 模式：无换行拼接 + 循环层建卡(tool_call_created)", async () => {
    const { hooks, events } = hooksFixture();
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.toolCardsCreatedInStream = false;
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("AB");
    expect(events.some((e) => e.kind === "tool_call_created" && e.toolCallId === "tc1")).toBe(true);
  });

  test("generationMs:每轮都下沉累计值(无上游 usage 也发),工具执行时间不计入(统计行 token/s 内测反馈)", async () => {
    const { hooks, events } = hooksFixture(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120)); // 模拟耗时工具
      return { output: [] };
    });
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    const wallStarted = Date.now();
    await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks);
    const wallMs = Date.now() - wallStarted;
    const usageEvents = events.filter((e) => e.kind === "usage") as Array<{ usage: { generationMs?: number } }>;
    // 两轮各发一次(rounds 无 usage 字段也要下沉累计值)。
    expect(usageEvents.length).toBe(2);
    const last = usageEvents[usageEvents.length - 1]!.usage.generationMs!;
    const first = usageEvents[0]!.usage.generationMs!;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThanOrEqual(first); // 单调累计
    // 全程含 120ms 工具执行,纯生成(假 readRound 即返)应远小于全程——留宽余量防 CI 抖动。
    expect(last).toBeLessThanOrEqual(Math.max(wallMs - 100, 1));
  });
});

describe("审批与异常", () => {
  test("pending 工具整批不执行,返回已累积文本", async () => {
    let executedCount = 0;
    const { hooks } = hooksFixture(async () => {
      executedCount += 1;
      return { output: [] };
    });
    const adapter = baseAdapter([
      { text: "前文", toolCalls: [{ id: "t1", name: "do_it", arguments: "{}" }, { id: "t2", name: "ask_user", arguments: "{}" }], replay: null },
    ]);
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("前文");
    expect(executedCount).toBe(0);
  });

  test("工具执行抛错被包装为错误输出,循环继续", async () => {
    const { hooks, events } = hooksFixture(async () => {
      throw new Error("tool boom");
    });
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("AB");
    const toolResult = events.find((e) => e.kind === "tool_result") as { output: Array<{ type: string }> };
    expect(toolResult.output.length).toBeGreaterThan(0);
  });

  test("MAX_TOOL_STEPS 超限抛 adapter 文案", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([withTool("x")]); // 永远返回工具轮
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("exhausted");
  });

  test("!ok 响应抛 provider 名与状态码,并记错误日志", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => new Response("bad key", { status: 401 });
    logged.length = 0;
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 401");
    expect(logged.some((l) => (l as { ok: boolean }).ok === false)).toBe(true);
  });

  test("R3-4:读流后中止抛 AbortError(三家统一,不再依赖 adapter 开关)", async () => {
    const { hooks } = hooksFixture();
    const controller = new AbortController();
    const adapter = baseAdapter([withTool("x")]);
    adapter.readRound = async () => {
      controller.abort();
      return withTool("x");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, controller.signal, hooks)).rejects.toThrow("Generation stopped");
  });

  test("R3-4:停止后本轮剩余工具不再执行(每迭代前查 abort)", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const { hooks } = hooksFixture(async (call) => {
      executed.push(call.function.name);
      controller.abort(); // 第一个工具执行后用户点停止
      return { output: [] };
    });
    // 一批两个工具:第一个执行后 abort,第二个必须被拦下
    const adapter = baseAdapter([
      { text: "批", toolCalls: [{ id: "t1", name: "tool_a", arguments: "{}" }, { id: "t2", name: "tool_b", arguments: "{}" }], replay: null },
    ]);
    await expect(runStreamingToolLoop(adapter, {}, assistant, controller.signal, hooks)).rejects.toThrow("Generation stopped");
    expect(executed).toEqual(["tool_a"]);
  });
});

describe("非流式降级(OpenAI 能力)", () => {
  test("fetch 失败→降级重试同轮成功;makeBody 生效;sink 收到提示", async () => {
    const { hooks, events } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    const adapter = baseAdapter([noTools("恢复成功")]);
    adapter.nonStreamFallback = {
      makeBody: (b) => ({ ...b, stream: false }),
      connectHint: "\n连接失败重试...",
      interruptHint: "\n中断重试...",
    };
    adapter.fetchRound = async (requestBody) => {
      bodies.push(requestBody);
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error("ECONNRESET");
      return okResponse();
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, assistant, undefined, hooks)).toBe("恢复成功");
    expect(bodies[0]).toEqual({ stream: true });
    expect(bodies[1]!.stream).toBe(false); // makeBody 覆盖 stream
    expect(events.some((e) => e.kind === "reasoning_delta" && String(e.text).includes("连接失败重试"))).toBe(true);
  });

  test("读流中断→降级重试;第二次仍失败则抛出", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.nonStreamFallback = { makeBody: (b) => b, connectHint: "c", interruptHint: "i" };
    adapter.readRound = async () => {
      throw new Error("stream cut");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("stream cut");
  });

  test("无降级能力时 fetch 失败直接抛", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      throw new Error("no fallback");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("no fallback");
  });
});

describe("用户级非流式(专题9:助手关闭流式输出)", () => {
  const nsAssistant = { id: "a1", mcpServers: [], streamOutput: false } as never;

  test("每一轮都经 makeNonStreamBody 改造,fetch/read 收到 nonStream=true", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const flags: Array<boolean | undefined> = [];
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.makeNonStreamBody = (b) => ({ ...b, stream: false });
    const origRead = adapter.readRound;
    adapter.fetchRound = async (requestBody, _round, _sig, nonStream) => {
      bodies.push(requestBody);
      flags.push(nonStream);
      return okResponse();
    };
    adapter.readRound = async (response, sig, nonStream) => {
      flags.push(nonStream);
      return origRead(response, sig, nonStream);
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, nsAssistant, undefined, hooks)).toBe("AB");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.stream === false)).toBe(true);
    expect(flags.every((f) => f === true)).toBe(true);
  });

  test("用户非流式时不做降级重试:失败直接抛,不产生额外计费请求", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.makeNonStreamBody = (b) => b;
    adapter.nonStreamFallback = { makeBody: (b) => b, connectHint: "c", interruptHint: "i" };
    let fetchCalls = 0;
    adapter.fetchRound = async () => {
      fetchCalls += 1;
      throw new Error("boom");
    };
    await expect(runStreamingToolLoop(adapter, {}, nsAssistant, undefined, hooks)).rejects.toThrow("boom");
    expect(fetchCalls).toBe(1);
  });

  test("adapter 未声明 makeNonStreamBody 时开关不生效(照常流式)", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = baseAdapter([noTools("流式")]);
    adapter.fetchRound = async (requestBody, _round, _sig, nonStream) => {
      bodies.push({ ...requestBody, nonStreamFlag: nonStream ?? false });
      return okResponse();
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, nsAssistant, undefined, hooks)).toBe("流式");
    expect(bodies[0]).toEqual({ stream: true, nonStreamFlag: false });
  });
});
