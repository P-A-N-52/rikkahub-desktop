// subprocess-engine/process-bridge.test.ts — 子进程生命周期与事件桥的端到端契约测试(T4)。
//
// 用真实子进程(bun -e 脚本)驱动骨架,锁方案 §六 T4 的核心验收:真实一个子进程
// stdout 流,验证行流→JSON-RPC→GenerationEvent 全链产出正确。覆盖:协议帧映射、
// 崩溃归因、取消杀树、终局收口(引擎未发 finished 时桥补 error/abort)。
//
// 交互形态:start 拿到会话先写 stdin 驱动假引擎,再 await drain 收全程事件——这正是
// adapter 接 dsh 时的真实驱动顺序(先握手/prompt,再收流)。

import { describe, expect, test } from "bun:test";

import type { GenerationEvent } from "../inference-engine/events";
import { spawnSubprocess, startSubprocessBridge, type JsonRpcMessage } from "./index";

/** bun 当前可执行(跨平台:process.execPath 已解析到 bun/bun.exe)。 */
const BUN = process.execPath;

/** 一个极简"假引擎":从 stdin 读一行 JSON 当 prompt,往 stdout 吐 NDJSON 协议帧。
 *  mode 控制行为:stream 正常流式 / no-terminal 不发 finished / crash 崩溃 / hang 挂起。 */
function fakeEngineScript(mode: string): string {
  const common = `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  `;
  if (mode === "stream") {
    return `${common}
      rl.on("line", (line) => {
        const prompt = JSON.parse(line);
        send({ method: "delta", params: { text: "部分:" + prompt.text } });
        send({ method: "delta", params: { text: "|全文" } });
        send({ method: "finished", params: { content: "部分:" + prompt.text + "|全文" } });
        process.exit(0);
      });
    `;
  }
  if (mode === "no-terminal") {
    return `${common}
      rl.on("line", () => { send({ method: "delta", params: { text: "半截" } }); process.exit(0); });
    `;
  }
  if (mode === "crash") {
    return `${common}
      rl.on("line", () => { console.error("引擎内部爆炸"); process.exit(3); });
    `;
  }
  // hang: 收 prompt 不回,挂起等被杀 → 测取消杀树。
  return `${common}
    rl.on("line", () => { /* 故意沉默,挂起 */ });
    setInterval(() => {}, 1000);
  `;
}

/** 极简映射器:delta → text_delta,finished → finished。 */
function fakeMapper(message: JsonRpcMessage): GenerationEvent[] {
  if (message.kind !== "notification") return [];
  const params = (message.params ?? {}) as { text?: string; content?: string };
  if (message.method === "delta" && params.text) return [{ kind: "text_delta", text: params.text }];
  if (message.method === "finished") return [{ kind: "finished", content: params.content ?? "", stopReason: "stop" }];
  return [];
}

function texts(events: GenerationEvent[]): string {
  return events.filter((e): e is Extract<GenerationEvent, { kind: "text_delta" }> => e.kind === "text_delta")
    .map((e) => e.text)
    .join("");
}

describe("spawnSubprocess 生命周期", () => {
  test("启动不存在的命令 → spawn_not_found 归因,不抛", async () => {
    const handle = spawnSubprocess({ cmd: "definitely-not-a-real-binary-xyz-123" });
    const info = await handle.exited;
    expect(info.kind).toBe("spawn_not_found");
  });

  test("崩溃退出 → crashed + 退出码 + stderr 尾部摘录", async () => {
    const handle = spawnSubprocess({ cmd: BUN, args: ["-e", fakeEngineScript("crash")] });
    handle.writeLine(JSON.stringify({ text: "触发" }));
    const info = await handle.exited;
    expect(info.kind).toBe("crashed");
    expect(info.exitCode).toBe(3);
    expect(info.stderrTail).toContain("引擎内部爆炸");
  }, 20_000);

  test("取消(杀进程树)→ cancelled,不算崩溃", async () => {
    const controller = new AbortController();
    const handle = spawnSubprocess({ cmd: BUN, args: ["-e", fakeEngineScript("hang")], signal: controller.signal });
    handle.writeLine(JSON.stringify({ text: "挂起我" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const info = await handle.exited;
    expect(info.kind).toBe("cancelled");
    expect(info.cancelled).toBe(true);
  }, 20_000);
});

describe("startSubprocessBridge 事件桥", () => {
  test("协议帧→GenerationEvent:delta 顺次映射 + finished 收口,干净退出", async () => {
    const session = startSubprocessBridge({ cmd: BUN, args: ["-e", fakeEngineScript("stream")], map: fakeMapper });
    session.handle.writeLine(JSON.stringify({ text: "你好" }));
    const { events, exit } = await session.drain();
    expect(exit.kind).toBe("clean_exit");
    expect(texts(events)).toBe("部分:你好|全文");
    expect(events.some((e) => e.kind === "finished")).toBe(true);
    // 干净退出且已有 finished → 桥不再补 error/abort。
    expect(events.some((e) => e.kind === "error" || e.kind === "abort")).toBe(false);
  }, 20_000);

  test("引擎未发 finished 即干净退出 → 桥补 error 收束(下游永不挂半开流)", async () => {
    const session = startSubprocessBridge({ cmd: BUN, args: ["-e", fakeEngineScript("no-terminal")], map: fakeMapper });
    session.handle.writeLine(JSON.stringify({ text: "半截话" }));
    const { events, exit } = await session.drain();
    expect(exit.kind).toBe("clean_exit");
    expect(texts(events)).toBe("半截");
    expect(events.some((e) => e.kind === "error")).toBe(true);
  }, 20_000);

  test("崩溃退出且未发终局 → 桥补 error;取消 → 桥补 abort", async () => {
    const crash = startSubprocessBridge({ cmd: BUN, args: ["-e", fakeEngineScript("crash")], map: fakeMapper });
    crash.handle.writeLine(JSON.stringify({ text: "炸" }));
    const crashResult = await crash.drain();
    expect(crashResult.exit.kind).toBe("crashed");
    expect(crashResult.events.some((e) => e.kind === "error")).toBe(true);

    const controller = new AbortController();
    const hung = startSubprocessBridge({ cmd: BUN, args: ["-e", fakeEngineScript("hang")], map: fakeMapper, signal: controller.signal });
    hung.handle.writeLine(JSON.stringify({ text: "挂起" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const hungResult = await hung.drain();
    expect(hungResult.exit.kind).toBe("cancelled");
    expect(hungResult.events.some((e) => e.kind === "abort")).toBe(true);
  }, 20_000);

  test("onEvent 实时下发与 drain 累积是同一份序列", async () => {
    const live: GenerationEvent[] = [];
    const session = startSubprocessBridge({
      cmd: BUN,
      args: ["-e", fakeEngineScript("stream")],
      map: fakeMapper,
      onEvent: (e) => live.push(e),
    });
    session.handle.writeLine(JSON.stringify({ text: "实时" }));
    const { events } = await session.drain();
    expect(live).toEqual(events);
    expect(texts(live)).toBe("部分:实时|全文");
  }, 20_000);

  test("非协议行(子进程日志)被诊断吞掉,不污染事件流", async () => {
    const diagnostics: string[] = [];
    const script = `
      process.stdout.write("[info] 引擎启动日志\\n");
      process.stdout.write(JSON.stringify({ method: "finished", params: { content: "完" } }) + "\\n");
      process.exit(0);
    `;
    const session = startSubprocessBridge({
      cmd: BUN,
      args: ["-e", script],
      map: fakeMapper,
      onDiagnostic: (note) => diagnostics.push(note),
    });
    const { events } = await session.drain();
    expect(diagnostics.some((d) => d.includes("非协议行") || d.includes("非 JSON"))).toBe(true);
    expect(events.some((e) => e.kind === "finished")).toBe(true);
  }, 20_000);
});
