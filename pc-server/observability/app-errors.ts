// observability/app-errors.ts — 统一错误上报通道(P2-1 批1)。
// 纪律:错误是横切关注点,本模块是它的唯一居所——catch 点要么 reportError,要么注明忽略原因。
// 本模块不依赖 api/ 层;SSE 广播由 api/sse.ts 通过 initAppErrorBroadcast 注入
// (与 working-set 的 SSE guard 同模式,避免 observability→api 循环依赖)。
// sink:内存环形缓冲 200 条(不落盘——诊断信息重启清零可接受,避免 state.json 膨胀)
// + console 镜像(warn/error 级) + 注入式 SSE 广播。

import type { AppErrorDomain, AppErrorDto, AppErrorSeverity } from "../foundation/types/dto";
import { id } from "../foundation/utils";
import { bootNote } from "./boot-trace";

const RING_LIMIT = 200;
/** 风暴合并窗口:同 domain+message 在窗口内只累加计数,不新增条目、不重复广播。 */
const MERGE_WINDOW_MS = 30_000;

const ring: AppErrorDto[] = [];
let broadcastFn: ((entry: AppErrorDto) => void) | null = null;

/** api/sse.ts 启动时注入,把新条目经 /api/events 通道推给订阅者(app_error 事件)。 */
export function initAppErrorBroadcast(fn: (entry: AppErrorDto) => void): void {
  broadcastFn = fn;
}

function causeToDetail(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) return cause.stack ?? cause.message;
  return String(cause);
}

/** 统一错误上报入口。error=用户必须知道,warn=可感知降级,info=仅进错误中心。
 *  code/params:前端文案键(settings:app_errors.codes.<code>)与插值参数,按当前界面
 *  语言渲染、切语言即时生效;message 仍为中文原文,作 console 镜像与键缺失兜底。 */
export function reportError(
  domain: AppErrorDomain,
  severity: AppErrorSeverity,
  message: string,
  cause?: unknown,
  code?: string,
  params?: Record<string, string | number>,
): void {
  const now = Date.now();
  // 风暴合并键:有码按 码+参数 匹配(参数不同是不同错误),无码退回 message 全文
  const mergeKey = code ? `${code}:${JSON.stringify(params ?? {})}` : message;
  // 从尾部找同 domain 同源的最近条目做风暴合并(尾部即最新,线性扫最多 200 条)
  for (let i = ring.length - 1; i >= 0; i--) {
    const entry = ring[i]!;
    const entryKey = entry.code ? `${entry.code}:${JSON.stringify(entry.params ?? {})}` : entry.message;
    if (entry.domain === domain && entryKey === mergeKey) {
      if (now - entry.at <= MERGE_WINDOW_MS) {
        entry.at = now;
        entry.count += 1;
        return;
      }
      break;
    }
  }
  const entry: AppErrorDto = {
    id: id(),
    at: now,
    count: 1,
    severity,
    domain,
    message,
    ...(code ? { code } : {}),
    ...(params ? { params } : {}),
    ...(causeToDetail(cause) !== undefined ? { detail: causeToDetail(cause) } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  if (severity === "error") console.error(`[${domain}] ${message}`, cause ?? "");
  else if (severity === "warn") console.warn(`[${domain}] ${message}`, cause ?? "");
  try {
    broadcastFn?.(entry);
  } catch {
    // 广播失败不反向污染上报路径(否则一个坏 SSE 客户端能让所有 reportError 抛错)。
  }
}

/** 错误中心快照(新→旧)。 */
export function recentAppErrors(): AppErrorDto[] {
  return [...ring].reverse();
}

/** 清空(用户在错误中心手动清除,以及单测隔离)。 */
export function clearAppErrors(): void {
  ring.length = 0;
}

/** 全面审查 4-2(P1):进程级兜底。定时器回调/游离 Promise(fire-and-forget)/SSE 定时
 *  广播抛到顶层时,Bun 默认直接退出进程——多用户形态(Docker/局域网)下等于全体掉线。
 *  捕获后上报错误中心 + console,进程继续运行。与逐点 try/catch(如 4-1 broadcastTo)
 *  形成纵深:逐点防已知热路径,全局网兜未知。幂等:重复调用不重复注册。 */
let safetyNetInstalled = false;
export function installProcessSafetyNet(): void {
  if (safetyNetInstalled) return;
  safetyNetInstalled = true;
  process.on("uncaughtException", (err) => {
    reportError("internal", "error", "未捕获异常，进程已兜底继续运行", err, "uncaught_exception");
    // R1 取证:JS 兜底也往 pending 落一行(含 stack)——若此异常随后把进程带走,遗言里能看到它。
    bootNote("uncaughtException", err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
  process.on("unhandledRejection", (reason) => {
    reportError("internal", "error", "未处理的 Promise 拒绝，进程已兜底继续运行", reason, "unhandled_rejection");
    bootNote("unhandledRejection", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
}
