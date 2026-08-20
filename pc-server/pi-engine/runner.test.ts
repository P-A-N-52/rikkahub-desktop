// pi-engine/runner.test.ts — pi 会话驱动器集成测试(P2)
//
// 真实链路:假 OpenAI SSE 服务器 → model-bridge 内存注册 → SessionManager(jsonl 落在
// 测试沙箱 pc-data)→ 事件桥 → sink。覆盖:首轮生成、jsonl 续会话(上下文真的回放给
// 上游)、损坏降级、预中止。上游失败→throw 的纯逻辑已在 event-bridge.test 锁定。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import type { GenerationEvent } from "../inference-engine/events";
import { model, provider } from "../model-providers";
import { resolvePiSessionPath, piSessionsDir } from "./session-files";
import { runPiGeneration } from "./runner";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";

const PROVIDER_ID = "00000000-0000-4000-8000-0000000000p2".replace("p2", "02");

let server: FakeOpenAiSseServer;
let cwd: string;

beforeAll(async () => {
  server = await startFakeOpenAiSse([
    { content: "第一轮回答", usage: { prompt_tokens: 11, completion_tokens: 3 } },
    { content: "第二轮回答", usage: { prompt_tokens: 25, completion_tokens: 4 } },
    { content: "损坏降级后的回答" },
  ]);
  cwd = mkdtempSync(join(tmpdir(), "pi-runner-cwd-"));
});

afterAll(async () => {
  await server.close();
});

function testContext(conversationId: string, promptText: string, extras: Partial<Parameters<typeof runPiGeneration>[0]> = {}) {
  const events: GenerationEvent[] = [];
  const ourProvider = provider({ id: PROVIDER_ID, name: "Runner Test Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
  const ourModel = model("fake-model", "Runner Test Model");
  return {
    events,
    ctx: {
      provider: ourProvider,
      model: ourModel,
      conversationId,
      cwd,
      promptText,
      sink: (event: GenerationEvent) => events.push(event),
      ...extras,
    },
  };
}

describe("pi runner 集成", () => {
  test("首轮:事件入 sink,jsonl 建在确定性路径,文件名回调触发", async () => {
    const { events, ctx } = testContext("conv-runner-1", "你好");
    const assignedFiles: string[] = [];
    const result = await runPiGeneration({ ...ctx, onSessionFile: (name) => { assignedFiles.push(name); } });

    expect(result.text).toBe("第一轮回答");
    expect(result.resumed).toBe(false);
    expect(result.sessionFileName).toBe("conv-runner-1.jsonl");
    expect(assignedFiles).toEqual(["conv-runner-1.jsonl"]);
    expect(existsSync(resolvePiSessionPath("conv-runner-1.jsonl"))).toBe(true);

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("usage");
    const text = events.filter((e): e is Extract<GenerationEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text).join("");
    expect(text).toBe("第一轮回答");
  }, 20_000);

  test("续会话:同一会话第二轮 resumed=true,历史真的回放给上游", async () => {
    const { ctx } = testContext("conv-runner-1", "继续");
    const result = await runPiGeneration({ ...ctx, storedSessionFileName: "conv-runner-1.jsonl" });
    expect(result.resumed).toBe(true);
    expect(result.text).toBe("第二轮回答");

    // 上游第二个请求必须携带第一轮上下文(引擎工作记忆生效的硬证据)
    const secondRequest = server.requests[1] as { messages?: Array<{ role: string; content?: unknown }> };
    const roles = (secondRequest.messages ?? []).map((m) => m.role);
    expect(roles.filter((role) => role === "user").length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(secondRequest.messages ?? []);
    expect(serialized).toContain("第一轮回答");
    expect(serialized).toContain("你好");
  }, 20_000);

  test("损坏降级:jsonl 非法内容 → 隔离改名 + 新会话照常生成", async () => {
    mkdirSync(piSessionsDir, { recursive: true });
    const corruptPath = resolvePiSessionPath("conv-runner-corrupt.jsonl");
    writeFileSync(corruptPath, "这不是 jsonl{{{\n");
    const { ctx } = testContext("conv-runner-corrupt", "hi");
    const result = await runPiGeneration({ ...ctx, storedSessionFileName: "conv-runner-corrupt.jsonl" });
    expect(result.resumed).toBe(false);
    expect(result.text).toBe("损坏降级后的回答");
    const quarantined = readdirSync(piSessionsDir).filter((name) => name.startsWith("conv-runner-corrupt.jsonl.corrupt-"));
    expect(quarantined.length).toBe(1);
  }, 20_000);

  test("预中止:signal 已 aborted 时直接抛 AbortError,不触碰上游", async () => {
    const requestsBefore = server.requests.length;
    const controller = new AbortController();
    controller.abort();
    const { ctx } = testContext("conv-runner-abort", "别发出去");
    await expect(runPiGeneration({ ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(server.requests.length).toBe(requestsBefore);
  }, 20_000);
});
