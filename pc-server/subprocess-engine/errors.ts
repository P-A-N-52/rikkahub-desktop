// subprocess-engine/errors.ts — 子进程引擎错误分类(T4 骨架)。
//
// 哲学与代理系统 classifyProxyError 同源(foundation/net.ts):子进程死 = 报错让用户处理,
// 绝不擅自降级、不悄悄直连重跑。返回的结构化分类既喂错误中心(reportError 的 code/params,
// 前端按界面语言渲染),也让适配层(dsh/codex/claude-code)能按类别给出一致的故障归因。
// 本模块只判"进程怎么死的",不判具体引擎的业务错误(那是各 adapter 的事)。

/** 子进程死亡分类(错误中心归因 + 适配层决策键)。 */
export type SubprocessExitKind =
  /** 找不到可执行文件(ENOENT)——引擎没装/不在 PATH。 */ | "spawn_not_found"
  /** 启动被拒(权限/EPERM/EACCES)——杀软拦截或权限不足。 */ | "spawn_denied"
  /** 运行期被信号杀死(SIGKILL/SIGTERM,含 OOM)。 */ | "killed_by_signal"
  /** 异常崩溃退出码(非 0 且非干净中止)。 */ | "crashed"
  /** 主动取消(我们的 kill 发起,非故障)。 */ | "cancelled"
  /** 干净退出(exitCode 0)。 */ | "clean_exit";

export interface SubprocessExitInfo {
  kind: SubprocessExitKind;
  /** 进程退出码(信号致死或未启动时为 null)。 */
  exitCode: number | null;
  /** 致命信号名(若非信号致死为 null)。 */
  signal: NodeJS.Signals | null;
  /** stderr 末尾摘录(截断,供错误详情展示;不含敏感数据)。 */
  stderrTail: string;
  /** 是否由我们主动取消(用户中止/超时杀)。 */
  cancelled: boolean;
}

/** 启动期错误分类(spawn 抛同步错时):从 errno 归因。 */
export function classifySpawnError(err: unknown): SubprocessExitKind {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ENOENT") return "spawn_not_found";
  if (code === "EPERM" || code === "EACCES") return "spawn_denied";
  return "crashed";
}

/** 运行期退出分类:信号致死 > 我们取消 > 非零退出码 > 干净退出。
 *  cancelled 由 process.ts 在发起 kill 时置位——SIGTERM 是我们杀的,不该算"崩溃"。 */
export function classifyExit(opts: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  stderrTail?: string;
}): SubprocessExitInfo {
  const { exitCode, signal, cancelled, stderrTail = "" } = opts;
  let kind: SubprocessExitKind;
  if (cancelled) kind = "cancelled";
  else if (signal) kind = "killed_by_signal";
  else if (exitCode !== 0) kind = "crashed";
  else kind = "clean_exit";
  return { kind, exitCode, signal, stderrTail, cancelled };
}

/** 面向用户/错误中心的一句话归因(中文,按 kind 给可操作建议)。
 *  name: 引擎显示名(dsh/codex/...),cmd: 启动命令(供 ENOENT 提示)。 */
export function describeExit(info: SubprocessExitInfo, name: string, cmd: string): string {
  switch (info.kind) {
    case "spawn_not_found":
      return `${name} 引擎未安装或不在 PATH(找不到命令 ${cmd})——请先安装并确认可执行文件可被找到。`;
    case "spawn_denied":
      return `${name} 引擎启动被拒(权限/杀软拦截)——请检查执行权限或安全软件拦截记录。`;
    case "killed_by_signal":
      return `${name} 引擎进程被信号终止(${info.signal ?? "未知"}${info.signal === "SIGKILL" ? ",可能内存不足被系统回收" : ""})。`;
    case "crashed":
      return `${name} 引擎异常退出(退出码 ${info.exitCode ?? "?"})${info.stderrTail ? `:${info.stderrTail}` : ""}。`;
    case "cancelled":
      return `${name} 引擎已中止。`;
    case "clean_exit":
      return `${name} 引擎已结束。`;
  }
}
