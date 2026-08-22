// subprocess-engine/bridge.ts — 子进程事件 → GenerationEvent 的翻译基座(T4 骨架)。
//
// 定位与 pi-engine/event-bridge.ts 对偶:pi 在进程内,把 pi 原生事件映射成
// GenerationEvent;子进程引擎在进程外,把"协议帧解析出的消息"映射成 GenerationEvent。
// 二者共享同一个输出契约(GenerationEvent,前端永远无感知),差异只在事件来源的形状。
//
// 本模块是**抽象基座**,刻意不含任何具体引擎的映射字典(那是各 adapter 的事——
// dsh 的 JSON-RPC method 命名与 codex 不同,只有各 adapter 知道)。基座只做三件
// 引擎无关的事:
//   1) 管线:把 spawn 句柄 + 行切分 + JSON-RPC 解析串起来,逐帧喂给映射器;
//   2) 背压与取消:AbortSignal 中止即杀进程树(经 process.ts),违例帧/非 JSON 行
//      记诊断不炸流程(子进程常混吐日志行);
//   3) 终局收口:进程退出时把"未等到 finished"的悬挂状态收口成 abort/error,
//      保证下游应用器永远能收束(不会出现"流没结尾"的半开消息)。
//
// 交互形态:start 与 drain 分离——adapter 先 start 拿到会话(可立即往 stdin 写首条
// prompt/握手帧),再 await drain 收全程事件。这把 pi event-bridge 的"有状态映射"
// 推广为"有状态管线 + 注入式映射器",映射器可用闭包自持关联状态(工具卡去重/参数
// 累计),基座不接管。

import type { GenerationEvent } from "../inference-engine/events";
import { createLineFramer, parseJsonRpcLine, type FrameYield, type JsonRpcMessage } from "./protocol";
import { spawnSubprocess, type SpawnSubprocessOptions, type SubprocessHandle } from "./process";
import type { SubprocessExitInfo } from "./errors";

/** 适配层注入的映射器:把一条协议消息翻译成 0..n 个 GenerationEvent。
 *  返回空数组 = 该消息无 part 语义(生命周期/心跳等)。映射器可用闭包自持关联状态
 *  (与 pi event-bridge 的 cards Map 同构),基座不接管。 */
export type SubprocessEventMapper = (message: JsonRpcMessage) => GenerationEvent[];

/** 启动一次桥接会话的选项。 */
export interface StartBridgeOptions extends Omit<SpawnSubprocessOptions, "onStdoutChunk"> {
  /** 协议消息 → GenerationEvent 的映射(引擎专属,adapter 注入)。 */
  map: SubprocessEventMapper;
  /** 事件下发的实时通道(可选):每映射出一个 GenerationEvent 立即回调,供 adapter
   *  直通 sink 做流式。不喂则只在 drain 的返回值里整批取。 */
  onEvent?: (event: GenerationEvent) => void;
  /** 诊断回调:协议违例/非 JSON 行时触发(默认 console.warn)。只记诊断,不打断。 */
  onDiagnostic?: (note: string) => void;
}

/** 一轮桥接会话的句柄。 */
export interface SubprocessBridgeSession {
  /** 子进程句柄(写 stdin 首条 prompt/握手、取消杀树)。 */
  readonly handle: SubprocessHandle;
  /** 收全程:await 进程退出,返回**已收口**的完整 GenerationEvent 序列与退出分类。
   *  只 resolve 一次;实时事件经 onEvent 先行下发,这里返回的是同一份的累积。 */
  drain(): Promise<{ events: GenerationEvent[]; exit: SubprocessExitInfo }>;
}

/** 启动一次子进程桥接会话:拉起进程、接好管线,立即返回句柄供 adapter 驱动 stdin。
 *  事件的实时下发(onEvent)与整批收口(drain)共用同一份累积序列,二者任选或并用。 */
export function startSubprocessBridge(options: StartBridgeOptions): SubprocessBridgeSession {
  const { map, onEvent, onDiagnostic = (note) => console.warn(`[subprocess-engine] ${note}`), ...spawnRest } = options;
  const events: GenerationEvent[] = [];
  const emit = (event: GenerationEvent) => {
    events.push(event);
    onEvent?.(event);
  };

  const framer = createLineFramer((frame: FrameYield) => {
    if (frame.type === "violation") {
      onDiagnostic(frame.reason);
      return;
    }
    const parsed = parseJsonRpcLine(frame.text);
    if (!parsed.ok) {
      // 非 JSON 行 = 子进程日志,记诊断不炸流程。
      onDiagnostic(`忽略非协议行:${parsed.reason} — ${parsed.raw.slice(0, 200)}`);
      return;
    }
    for (const event of map(parsed.message)) emit(event);
  });

  const handle = spawnSubprocess({
    ...spawnRest,
    onStdoutChunk: (chunk) => framer.feed(chunk),
  });

  let drained = false;
  const drain = async (): Promise<{ events: GenerationEvent[]; exit: SubprocessExitInfo }> => {
    if (drained) {
      // 幂等:重复 drain 返回当前累积(事件可能仍在实时新增,但终局已结算)。
      const exit = await handle.exited;
      return { events, exit };
    }
    drained = true;
    const exit = await handle.exited;
    framer.flush();

    // 终局收口:进程已退出,若映射器没发过 finished/error/abort,补一个让下游收束。
    // 用户取消(cancelled)→ abort;干净退出但没 finished → 协议违约,记诊断补 error;
    // 异常退出 → error。
    const hasTerminal = events.some((e) => e.kind === "finished" || e.kind === "error" || e.kind === "abort");
    if (!hasTerminal) {
      if (exit.cancelled) {
        emit({ kind: "abort" });
      } else if (exit.kind === "clean_exit") {
        onDiagnostic("子进程干净退出但未发出终局事件,按异常收束");
        emit({ kind: "error", error: "引擎未发出结束信号即退出" });
      } else {
        emit({ kind: "error", error: `引擎异常终止(${exit.kind})` });
      }
    }
    return { events, exit };
  };

  return { handle, drain };
}
