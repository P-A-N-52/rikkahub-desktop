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
// P3 工具面:noTools:"builtin"——pi 内建 read/bash/edit/write 一律不启用(它们绕开
// 我们的审批与边界壳),我们的七工具经 ctx.tools 以 customTools 注册
// (pi-engine/workspace-tools.ts,审批内化在工具 execute 里)。不传 tools 即纯对话
// (与 P2 语义等价:无任何激活工具,系统提示词 Available tools 为 "(none)")。

import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { GenerationEventSink } from "../inference-engine/events";
import type { Model, Provider } from "../foundation/types";
import { piAgentDir } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import { createPiModelRuntime, mapProviderModelToPi, type PiModelLimits } from "./model-bridge";
import { createPiEventBridge } from "./event-bridge";
import { clearToolApprovalWaiters } from "./approval-gate";
import type { PiSessionResources } from "./resources";
import { piSessionFileNameFor, piSessionsDir, quarantineCorruptPiSession, resolvePiSessionPath } from "./session-files";

export interface PiGenerationContext {
  /** 生效 provider/model(调用方经 findModel 解析,providerOverwrite 已展开)。 */
  provider: Provider;
  model: Model;
  /** 模型极限(P5:orchestrator 从 models.dev/助手配置取值;不传用 model-bridge 保守默认)。
   *  contextWindow 决定 pi 自动压缩阈值(contextWindow - reserveTokens),必须尽量真实。 */
  modelLimits?: PiModelLimits;
  /** 会话身份与引擎记忆。 */
  conversationId: string;
  /** pi_session_file 列的当前值(无记录传 null)。 */
  storedSessionFileName?: string | null;
  /** 会话工作目录(工作区边界内的绝对路径)。 */
  cwd: string;
  /** 本轮用户输入(文本;文档/OCR 已由 pi-engine/attachments 文本化)。 */
  promptText: string;
  /** 图片附件(pi 原生 prompt images 通道,P4 附件面)。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** 资源装配(P4:技能/AGENTS.md/appendSystemPrompt/受控 settings,
   *  生产侧 = createPiSessionResources;不传 = 纯对话,pi 默认资源面全关不了——
   *  仅测试/冒烟场景使用,生产路由必须传)。 */
  resources?: PiSessionResources;
  /** customTools(生产侧 = 七个工作区工具 + 通用工具/MCP 桥;不传 = 纯对话)。 */
  tools?: ToolDefinition[];
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
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model, ctx.modelLimits);
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
    // "builtin" 只关内建工具;customTools 经 includeAllExtensionTools 全部激活
    // (sdk.ts:246-251 + agent-session._refreshToolRegistry,§七-3 实证)。
    noTools: "builtin",
    customTools: ctx.tools ?? [],
    // P4 资源统一:受控 ResourceLoader(技能白名单/AGENTS.md 边界过滤/appendSystemPrompt)
    // + 受控 SettingsManager(inMemory,封死 .pi/settings.json 注入面)。
    // 注意 sdk 只对自建 loader 调 reload,resources 在装配处已 reload 完毕。
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
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
    // expandPromptTemplates:false——用户消息逐字直达模型。pi 默认会把 "/" 开头的输入
    // 当模板/扩展命令拦截(agent-session.ts:1122),我们的会话 UX 不走 pi 命令面。
    await session.prompt(ctx.promptText, {
      expandPromptTemplates: false,
      ...(ctx.images?.length ? { images: ctx.images } : {}),
    });
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
    // 审批等待者兜底清扫:正常路径下等待者随用户决定/中止即刻注销,这里只防实现
    // 疏漏把 execute 的 Promise 泄漏成永久悬挂(approval-gate 头注)。
    clearToolApprovalWaiters(ctx.conversationId);
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

// ===== P5:pi 原生手动压缩 =====

export interface PiCompactionContext {
  provider: Provider;
  model: Model;
  modelLimits?: PiModelLimits;
  conversationId: string;
  storedSessionFileName?: string | null;
  cwd: string;
  /** 受控资源装配(生产必传:压缩会话也不许打开 .pi/settings.json 注入面)。 */
  resources?: PiSessionResources;
  /** 用户附加指示(compress 框的 additionalPrompt → pi compact customInstructions)。 */
  customInstructions?: string;
  /** 生成事件下沉:压缩路径只产 engine_status(压缩中/摘要重试),经桥同一映射。 */
  sink: GenerationEventSink;
  signal?: AbortSignal;
  onSessionFile?: (fileName: string) => void;
}

export interface PiCompactionResult {
  sessionFileName: string;
  summary: string;
  tokensBefore: number;
  /** pi 对压缩后上下文的估算(可选字段,拿不到为 null;仅展示/日志用途)。 */
  estimatedTokensAfter: number | null;
}

/** pi 已知压缩失败信息 → 人话(其余原样上抛,handler 统一转 400)。 */
const PI_COMPACT_ERROR_TEXT: Record<string, string> = {
  "Already compacted": "引擎记忆刚完成压缩,无需再次压缩。",
  "Nothing to compact (session too small)": "引擎记忆还很小,暂无可压缩的历史。",
};

/**
 * 手动压缩工作区会话的引擎记忆(方案 P5:手动压缩按钮改调 pi 原生 compaction)。
 * 装配面与 runPiGeneration 同款(模型运行时/受控资源/事件桥),差别只在驱动动作:
 * prompt → session.compact。压缩摘要由 pi 追加进 jsonl(appendCompaction),UI 历史
 * 不动——双表征语义下,决定上游上下文的是引擎记忆,不是 UI 历史。
 */
export async function runPiCompaction(ctx: PiCompactionContext): Promise<PiCompactionResult> {
  if (ctx.signal?.aborted) throw new DOMException("Compaction cancelled", "AbortError");
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model, ctx.modelLimits);
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
    noTools: "builtin",
    customTools: [],
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
  });

  const bridge = createPiEventBridge();
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
  });
  const onAbort = () => {
    session.abortCompaction();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Compaction cancelled", "AbortError");
    const result = await session.compact(ctx.customInstructions?.trim() || undefined);
    return {
      sessionFileName: opened.fileName,
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? null,
    };
  } catch (err) {
    // 取消统一为 AbortError(compact 内部以普通 Error("Compaction cancelled") 上抛)。
    const message = err instanceof Error ? err.message : String(err);
    if (ctx.signal?.aborted || message === "Compaction cancelled") {
      throw new DOMException("Compaction cancelled", "AbortError");
    }
    throw new Error(PI_COMPACT_ERROR_TEXT[message] ?? `工作区引擎压缩失败：${message}`);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}
