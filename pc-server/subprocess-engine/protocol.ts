// subprocess-engine/protocol.ts — 子进程 stdout 的行流 / JSON-RPC 帧解析(T4 骨架)。
//
// 子进程引擎(dsh/codex/claude-code)与我们之间走 stdio:一行一个 JSON 帧(NDJSON)是
// 这类 CLI 的事实标准(dsh 即 JSON-RPC over stdio)。本模块把字节流切成"帧",再把帧
// 解析成结构化消息,两件事解耦——帧边界(行)与载荷语义(JSON-RPC)各自独立可测。
//
// 背压纪律:子进程可能一股脑吐出大段输出(工具结果/base64)。我们以 ReadableStream 的
// 拉取语义逐 chunk 消费,内部缓冲只攒"尚未成行"的尾部碎片;成行即上交,绝不在内存里
// 攒整条历史。超过 MAX_LINE_BYTES 的单行判为协议违例(防失控子进程撑爆内存)。

/** 单行最大字节数(防卫上限,防失控输出撑爆内存)。超出即判协议违例。 */
export const MAX_LINE_BYTES = 1 << 20; // 1 MiB

/** 帧解析产出的三种去向:成帧交付 / 协议违例 / 流结束冲刷。 */
export type FrameYield =
  | { type: "line"; text: string }
  | { type: "violation"; reason: string };

/** 行切分器:feed(chunk) 增量喂字节,内部攒尾部碎片,成行即经 onFrame 上交。
 *  纯增量、无回看;CRLF 与 LF 都认(Windows 子进程)。 */
export function createLineFramer(onFrame: (frame: FrameYield) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  let pendingBytes = 0;
  let violated = false;

  function feed(chunk: Uint8Array): void {
    if (violated) return;
    pending += decoder.decode(chunk, { stream: true });
    pendingBytes += chunk.byteLength;
    let newlineIndex: number;
    // 逐行切出;最后一行无换行符则留在 pending 等下一片/冲刷。
    while ((newlineIndex = pending.indexOf("\n")) >= 0) {
      let line = pending.slice(0, newlineIndex);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      pending = pending.slice(newlineIndex + 1);
      pendingBytes = Buffer.byteLength(pending, "utf8");
      if (line.length > 0) onFrame({ type: "line", text: line });
    }
    if (pendingBytes > MAX_LINE_BYTES) {
      violated = true;
      onFrame({ type: "violation", reason: `单行超过 ${MAX_LINE_BYTES} 字节,判定协议违例` });
    }
  }

  /** 流结束:把末尾无换行的残行冲出来(若有)。 */
  function flush(): void {
    if (violated) return;
    const tail = pending + decoder.decode();
    pending = "";
    pendingBytes = 0;
    if (tail.length > 0) onFrame({ type: "line", text: tail });
  }

  return { feed, flush, get violated() { return violated; } };
}

// ---- JSON-RPC 2.0 over NDJSON ----

/** 解析出的 JSON-RPC 消息(只取我们关心的面,其余字段宽容忽略)。
 *  - request: 有 id 有 method(子进程向我们发问,如请求审批);
 *  - response: 有 id 无 method(result 或 error);
 *  - notification: 有 method 无 id(子进程单方面播报,如流式增量)。 */
export type JsonRpcMessage =
  | { kind: "request"; id: string | number; method: string; params?: unknown }
  | { kind: "response"; id: string | number; result?: unknown; error?: JsonRpcErrorObject }
  | { kind: "notification"; method: string; params?: unknown };

export interface JsonRpcErrorObject {
  code?: number;
  message?: string;
  data?: unknown;
}

export type ParseOutcome =
  | { ok: true; message: JsonRpcMessage }
  | { ok: false; raw: string; reason: string };

/** 把一行 NDJSON 解析为 JSON-RPC 消息。非 JSON / 不合形 → ok:false(不抛,交由上层
 *  决定忽略还是记诊断——子进程可能混吐日志行)。 */
export function parseJsonRpcLine(line: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, raw: line, reason: "非 JSON 行" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, raw: line, reason: "JSON 载荷不是对象" };
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const method = record.method;
  const hasId = typeof id === "string" || typeof id === "number";
  const hasMethod = typeof method === "string" && method.length > 0;
  if (hasMethod && hasId) {
    return { ok: true, message: { kind: "request", id, method, params: record.params } };
  }
  if (hasId && !hasMethod) {
    const error = typeof record.error === "object" && record.error !== null
      ? (record.error as JsonRpcErrorObject)
      : undefined;
    return { ok: true, message: { kind: "response", id, result: record.result, error } };
  }
  if (hasMethod && !hasId) {
    return { ok: true, message: { kind: "notification", method, params: record.params } };
  }
  return { ok: false, raw: line, reason: "既非 request/response 也非 notification(缺 id 与 method)" };
}
