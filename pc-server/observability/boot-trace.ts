// observability/boot-trace.ts — 启动/崩溃取证黑匣子(R1 取证:issue 后端无声退出)。
//
// 设计哲学(产品纪律):日志不是流水账,是"出事时才存在的黑匣子"。全程不打扰用户——
// 没有"上次异常退出"警告;一切靠文件生灭表达,用户只有真碰上崩溃、主动去翻 logs/
// 或在错误中心看到那条 warn 时才会发现它。
//
// 状态机(与用户对齐,Firefox sessionstore / Chrome exit_type 同款"残留即异常"):
//   - pending 全程存在:应用一启用就诞生,标记本次会话 + 逐条里程碑。
//   - 干净退出(SIGINT/SIGTERM//shutdown 端点):删 pending + 删上次可能残留的 server.log
//     —— "下次正常启动、正常退出,则日志被清除",关机/强退的假报警就此归零,用户无感。
//   - pending 残留到下次启动 = 上次非正常退出(崩溃/关机/强退):转存成 server.log(遗言),
//     附崩溃区间判读。它一直留到"下次正常退出"才被清掉。
//   净效果:真崩溃 → server.log 残留(起不来的场景用户没能正常退出,故稳定留存);
//           直接关机 → server.log 短暂残留,下次正常退出即清,不打扰。
//
// 为什么全用同步 IO:段错误/强杀让进程瞬间蒸发,异步写会丢;同步写在每一步落盘后才往下走,
// 哪怕下一步就崩,文件里已留下"死前走到的最后一步"。只写几行,开销可忽略。
//
// 隐私边界:只写进程/版本/里程碑/错误摘要,绝不写会话内容、API key、消息文本。
//
// 可测性:核心是 *In(logsDir) 注入目录版(与 instance-lock 同构),生产路径用全局 logsDir
// 的薄包装;单测注入 mkdtemp 目录,不碰真实数据目录。

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { logsDir } from "../foundation/paths";

const PENDING_NAME = "server.boot.pending.log";
const LOG_NAME = "server.log";

/** 启动里程碑序列(固定顺序)。判读时找"已成功完成的最后一项",死时它停在崩溃区间下沿。 */
const MILESTONES = [
  "进程拉起",
  "已拿数据目录锁",
  "端口已绑定",
  "bootstrap 完成",
] as const;
export type BootMilestone = (typeof MILESTONES)[number];

function isoNow(): string {
  return new Date().toISOString();
}

function pendingPathIn(dir: string): string {
  return join(dir, PENDING_NAME);
}

function logPathIn(dir: string): string {
  return join(dir, LOG_NAME);
}

function header(): string {
  return (
    [
      `# Rikkahub 运行取证 —— 本文件在应用正常退出时自动删除;残留即上次未干净退出`,
      `启动时间: ${isoNow()}`,
      `pid: ${process.pid}`,
      `runtime: bun ${process.versions.bun ?? "?"} / ${process.platform} ${process.arch}`,
      ``,
      `里程碑:`,
    ].join("\n") + "\n"
  );
}

// ---------- 注入目录核心(纯函数式,可测) ----------

/** 为一次会话写 pending 头(覆盖旧值)。返回是否成功(失败=降级不取证,不阻塞启动)。 */
export function beginBootTraceIn(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pendingPathIn(dir), header(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 往 pending 追加一行(里程碑 / 兜底异常)。文件不存在时静默跳过(如盘只读)。 */
export function appendBootTraceIn(dir: string, line: string): void {
  try {
    appendFileSync(pendingPathIn(dir), `  [${isoNow()}] ${line}\n`, "utf8");
  } catch {
    // 取证是锦上添花:盘写不进绝不反向阻塞启动/退出。
  }
}

/**
 * 上次 pending 残留(未干净退出)→ 转存成 server.log 供查看,补一行"死在哪两步之间"
 * 的判读,随后删除 pending(本次会话会重建自己的)。返回是否发生了转存。
 */
export function capturePreviousBootTraceIn(dir: string): boolean {
  try {
    const pending = pendingPathIn(dir);
    if (!existsSync(pending)) return false;
    let body = "";
    try {
      body = readFileSync(pending, "utf8");
    } catch {
      body = "# 上次会话的取证文件读取失败(可能已损坏)";
    }
    const lastDone = lastReachedMilestone(body);
    const verdict = lastDone === null
      ? "判读: 未走到任何里程碑 —— 进程在“进程拉起”之前即被终止(极早期:运行时加载/反病毒拦截)。"
      : `判读: 最后完成「${lastDone}」 —— 上次会话非正常结束(崩溃或直接关机/强制退出),进程死在这一步与下一步之间。`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPathIn(dir), `${body.trimEnd()}\n\n${verdict}\n`, "utf8");
    rmSync(pending, { force: true });
    return true;
  } catch {
    return false;
  }
}

function lastReachedMilestone(pendingBody: string): string | null {
  let found: string | null = null;
  for (const m of MILESTONES) {
    if (pendingBody.includes(`] ${m}`)) found = m;
  }
  return found;
}

/** 读取上次崩溃转存(server.log)的内容;不存在返回 null。供错误中心启动时呈现。 */
export function readPreviousCrashLogIn(dir: string): string | null {
  try {
    const p = logPathIn(dir);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * 干净退出时调用:删本次 pending + 删上次残留的 server.log。
 * 后者即"下次正常退出则日志被清除"——关机/强退留下的假报警随本次正常退出归零。
 */
export function cleanExitIn(dir: string): void {
  try {
    rmSync(pendingPathIn(dir), { force: true });
  } catch {
    // 删不掉(占用/权限)无害——下次 capturePrevious 会按陈旧文件转存。
  }
  try {
    rmSync(logPathIn(dir), { force: true });
  } catch {
    // 同上,无害。
  }
}

// ---------- 生产路径薄包装(全局 logsDir) ----------

let sessionActive = false;

/** 启动最早期调用:先转存上次崩溃残留(若有),再为本次开 pending。 */
export function bootTraceStartup(): void {
  capturePreviousBootTraceIn(logsDir);
  sessionActive = beginBootTraceIn(logsDir);
}

export function bootMilestone(milestone: BootMilestone, extra?: string): void {
  if (!sessionActive) return;
  appendBootTraceIn(logsDir, `${milestone}${extra ? ` — ${extra}` : ""}`);
}

/** 记录一条 JS 兜底异常(uncaughtException/unhandledRejection),stack 一并留证。 */
export function bootNote(kind: string, detail: string): void {
  if (!sessionActive) return;
  appendBootTraceIn(logsDir, `${kind}: ${detail}`);
}

/** 干净退出时调用:删 pending + 删上次残留的 server.log(假报警归零)。幂等。 */
export function bootCleanExit(): void {
  sessionActive = false;
  cleanExitIn(logsDir);
}

/** 错误中心启动时读:上次崩溃转存内容(不存在=上次干净退出)。 */
export function readPreviousCrashLog(): string | null {
  return readPreviousCrashLogIn(logsDir);
}
