// pi-engine/runner.ts — pi 会话生成驱动器(P2)
//
// 一次调用 = 我们会话模型里的一轮生成:注入模型运行时(P1 model-bridge)→ 打开/创建
// 引擎工作记忆(session-files)→ 订阅事件经桥(event-bridge)映射为 GenerationEvent
// 灌进调用方 sink(生产侧即 generateAnswer 的共享应用器)→ prompt 等待回合结束 →
// 按桥观察到的终局决定 return/throw。
//
// 契约与聊天引擎流式函数对齐:sink 语义相同、abort 经 AbortSignal、上游失败以 throw
// 上抛(generateAnswer 的失败分支统一做 reportError/失败文本/注解)。P3 把工作区会话的
// runGeneration 切到本驱动器,generateAnswer 的收尾/错误/审批框架原样复用。
//
// P2 工具面策略:noTools:"all"——pi 内建 read/bash/edit/write 一律不启用(它们绕开
// 我们的审批与边界壳,P3 以 customTools 形式接回我们已 pi 化的七工具)。

import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { GenerationEventSink } from "../inference-engine/events";
import type { Model, Provider } from "../foundation/types";
import { piAgentDir } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import { createPiModelRuntime, mapProviderModelToPi } from "./model-bridge";
import { createPiEventBridge } from "./event-bridge";
import { piSessionFileNameFor, piSessionsDir, quarantineCorruptPiSession, resolvePiSessionPath } from "./session-files";

export interface PiGenerationContext {
  /** 生效 provider/model(调用方经 findModel 解析,providerOverwrite 已展开)。 */
  provider: Provider;
  model: Model;
  /** 会话身份与引擎记忆。 */
  conversationId: string;
  /** pi_session_file 列的当前值(无记录传 null)。 */
  storedSessionFileName?: string | null;
  /** 会话工作目录(工作区边界内的绝对路径)。 */
  cwd: string;
  /** 本轮用户输入(纯文本;附件面 P4)。 */
  promptText: string;
  /** 生成事件下沉(生产侧 = conversations/generation-apply 的应用器)。 */
  sink: GenerationEventSink;
  signal?: AbortSignal;
  /** 引擎记忆文件名分配回调:prompt 前即回调,调用方负责写列并持久化——
   *  流式中途崩溃也不能丢"会话↔jsonl"的关联。 */
  onSessionFile?: (fileName: string) => void;
}

export interface PiGenerationResult {
  /** 全程 assistant 可见文本(镜像聊天引擎 allContent 口径:trim,空则占位)。 */
  text: string;
  sessionFileName: string;
  /** true = 本轮续上了既有引擎记忆。 */
  resumed: boolean;
  stopReason: string | null;
}

export interface OpenPiSessionResult {
  manager: SessionManager;
  /** 应写入 pi_session_file 列的文件名。 */
  fileName: string;
  /** true = 从既有 jsonl 续上了引擎记忆。 */
  resumed: boolean;
}

/**
 * 打开(续会话)或创建会话的引擎工作记忆。
 * - 列里有文件名且文件存在 → SessionManager.open 续会话(cwdOverride 用当前工作目录,
 *   工作区被用户搬迁后不被 jsonl 头里的旧 cwd 钉死);
 * - 文件损坏(open 抛)→ 隔离 `.corrupt-<ts>` + reportError(warn) + 降级新会话
 *   (UI 历史不丢,只丢引擎工作记忆——方案 §4.6 语义);
 * - 无记录/文件不存在 → 在确定性路径上建新会话(session-manager.ts 实证:open 不存在
 *   的路径即"在该路径建新会话",且首个 assistant 消息落盘前文件不创建,空会话零磁盘垃圾)。
 */
export function openOrCreatePiSession(options: {
  conversationId: string;
  storedFileName?: string | null;
  cwd: string;
}): OpenPiSessionResult {
  mkdirSync(piSessionsDir, { recursive: true });
  const fileName = options.storedFileName ? basename(options.storedFileName) : piSessionFileNameFor(options.conversationId);
  const path = resolvePiSessionPath(fileName);
  if (existsSync(path)) {
    try {
      return { manager: SessionManager.open(path, piSessionsDir, options.cwd), fileName, resumed: true };
    } catch (err) {
      quarantineCorruptPiSession(path);
      reportError(
        "pi-engine",
        "warn",
        "工作区会话的引擎记忆文件损坏，已降级为全新引擎会话（界面历史不受影响）",
        err,
        "pi_session_corrupt",
      );
    }
  }
  // 确定性命名下,降级新会话与全新会话共用同一路径(损坏件已被隔离挪走)。
  return { manager: SessionManager.open(path, piSessionsDir, options.cwd), fileName, resumed: false };
}

export async function runPiGeneration(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createPiModelRuntime(mapped.mapping);

  const opened = openOrCreatePiSession({
    conversationId: ctx.conversationId,
    storedFileName: ctx.storedSessionFileName,
    cwd: ctx.cwd,
  });
  ctx.onSessionFile?.(opened.fileName);

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: piAgentDir,
    modelRuntime: runtime,
    model,
    sessionManager: opened.manager,
    noTools: "all",
  });

  const bridge = createPiEventBridge();
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
  });
  const onAbort = () => {
    void session.abort();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    await session.prompt(ctx.promptText);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }

  const outcome = bridge.outcome();
  // 上游失败且非用户中止 → 抛给调用方失败分支(与聊天引擎 throw 语义一致)。
  // 用户中止 → 正常返回已生成部分,调用方按 signal.aborted 走中止收尾。
  if (outcome.stopReason === "error" && !ctx.signal?.aborted) {
    throw new Error(outcome.errorMessage || "pi 引擎生成失败(未提供错误详情)");
  }
  return {
    text: outcome.text.trim() || "(empty response)",
    sessionFileName: opened.fileName,
    resumed: opened.resumed,
    stopReason: outcome.stopReason,
  };
}
