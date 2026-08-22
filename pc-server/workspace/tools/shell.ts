// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/utils/shell.ts(v0.83.0)被 bash 工具引用的子集。
// PC 适配:getShellEnv 删去 pi 私有 binDir 注入(PC 无自带 bin 目录)。
// bash 语义神圣(§5.1):Windows 只找 Git Bash/PATH 上的 bash,绝不做 PowerShell 兜底
// ——bash 工具跑 PowerShell 会让模型的 bash 语法全灭。找不到时 getShellConfig 抛错,
// 上层(runtime.shellAvailability)据此不挂载 bash 并挂载 grep/find/ls 兜底。
//
// 2026-08-01 探测加固(有意偏离 pi,真实故障驱动):
// 1. Git 装在非标准路径时(如 D:\SoftWare\Git),固定位置探不到,而机器 PATH 上通常只有
//    Git\cmd(含 git.exe 不含 bash.exe)——新增"从 git.exe 推导同装 bash.exe"一步;
// 2. `where bash.exe` 在 GUI 进程里常常只命中 C:\Windows\System32\bash.exe(WSL 旧版
//    启动器)。它"存在"但未装 WSL 发行版时跑什么都失败,还输出 UTF-16 乱码——Windows
//    候选必须通过一次真实的 `echo` 运行验证才算可用,WSL 启动器排在候选序最后;
// 3. 验证有进程开销,结果做模块级缓存;runtime.refreshShellAvailability 经
//    resetShellConfigCache 同步清掉(用户装完 Git 后重探)。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { reportError } from "../../observability/app-errors";

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

export function getBashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

/** `where`/`which` 查可执行文件,返回全部命中(Windows 侧存在性已核实)。 */
function findExecutablesOnPath(executable: string): string[] {
  const isWindows = process.platform === "win32";
  try {
    const result = spawnSync(isWindows ? "where" : "which", [executable], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Windows 的 where 可能吐不存在的路径;Unix 的 which 输出可信(Termux 等特殊文件系统)
      .filter((line) => line && (!isWindows || existsSync(line)));
  } catch {
    return [];
  }
}

/** 运行验证:候选 shell 真能执行一条 echo 才算可用(挡住未装发行版的 WSL 启动器)。
 *  导出供 embedded-bash 复用:内嵌 bash 落地后同样需过一次真实 echo 才算就绪。 */
export function shellRunsBash(config: ShellConfig): boolean {
  const marker = "__rikkahub_shell_ok__";
  try {
    const result =
      config.commandTransport === "stdin"
        ? spawnSync(config.shell, config.args, {
            input: `echo ${marker}\n`,
            encoding: "utf-8",
            timeout: 10_000,
            windowsHide: true,
          })
        : spawnSync(config.shell, [...config.args, `echo ${marker}`], {
            encoding: "utf-8",
            timeout: 10_000,
            windowsHide: true,
          });
    return result.status === 0 && String(result.stdout ?? "").includes(marker);
  } catch {
    return false;
  }
}

/** 从 PATH 上的 git.exe 推导同一 Git 安装内的 bash.exe(覆盖非标准安装路径)。 */
function deriveBashFromGit(): string[] {
  const candidates: string[] = [];
  for (const gitPath of findExecutablesOnPath("git.exe")) {
    // 典型布局:<install>\cmd\git.exe 或 <install>\bin\git.exe 或 <install>\mingw64\bin\git.exe
    const installRoots = new Set<string>();
    let dir = dirname(gitPath);
    for (let hops = 0; hops < 2; hops++) {
      installRoots.add(dir);
      dir = dirname(dir);
    }
    for (const root of installRoots) {
      candidates.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
    }
  }
  return candidates.filter((path) => existsSync(path));
}

/** Windows 候选清单(按可信度排序,WSL 旧版启动器垫底);去重后逐一做运行验证。 */
function windowsBashCandidates(): string[] {
  const candidates: string[] = [];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  candidates.push(...deriveBashFromGit());
  candidates.push(...findExecutablesOnPath("bash.exe"));

  const seen = new Set<string>();
  const normal: string[] = [];
  const legacyWsl: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key) || !existsSync(candidate)) continue;
    seen.add(key);
    (isLegacyWslBashPath(candidate) ? legacyWsl : normal).push(candidate);
  }
  return [...normal, ...legacyWsl];
}

/** 已验证配置的模块级缓存(仅默认路径;customShellPath 用户显式指定,不进缓存)。 */
let verifiedConfigCache: ShellConfig | null = null;

export function resetShellConfigCache(): void {
  verifiedConfigCache = null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, git.exe-derived, then bash on PATH —
 *    each candidate must pass a real `echo` run (verified result is cached)
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
  // 1. Check user-specified shell path
  if (customShellPath) {
    if (existsSync(customShellPath)) {
      return getBashShellConfig(customShellPath);
    }
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }

  if (process.platform === "win32") {
    if (verifiedConfigCache) return verifiedConfigCache;

    const candidates = windowsBashCandidates();
    for (const candidate of candidates) {
      const config = getBashShellConfig(candidate);
      if (shellRunsBash(config)) {
        verifiedConfigCache = config;
        return config;
      }
    }

    // 内嵌兜底(最后一道网)。惰性 import 消除 shell.ts ↔ embedded-bash.ts 的循环依赖
    // (embedded-bash 复用本文件的 shellRunsBash/getBashShellConfig)。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { embeddedBashAvailableSync, ensureEmbeddedBash } = require("./embedded-bash") as typeof import("./embedded-bash");

    // 同步快路径:已落地且戳匹配的内嵌 bash,验证可用即用并缓存。
    const embedded = embeddedBashAvailableSync();
    if (embedded) {
      const config = getBashShellConfig(embedded);
      if (shellRunsBash(config)) {
        verifiedConfigCache = config;
        return config;
      }
    }

    // 内嵌未落地:后台触发懒落地(不阻塞本次同步返回),完成后清缓存,下次探测即命中。
    // 本次仍走抛错(上层挂 grep/find/ls 兜底);落地约百毫秒,用户重进/前端 refresh 即得 bash。
    // 失败已在 ensureEmbeddedBash 内 reportError,这里不再重复上报。
    void ensureEmbeddedBash()
      .then(() => resetShellConfigCache())
      .catch(() => { /* 落地失败已上报;保持抛错兜底 */ });

    const searched = candidates.length
      ? `Found but not runnable (e.g. WSL launcher without an installed distribution):\n${candidates.map((p) => `  ${p}`).join("\n")}`
      : "No bash.exe candidates were found on this machine.";
    throw new Error(
      `No working bash shell found. A built-in terminal is being prepared in the background — re-check in a moment. Otherwise:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        `  3. Set a custom bash path in Settings\n\n` +
        searched,
    );
  }

  // Unix: try /bin/bash, then bash on PATH, then fallback to sh
  if (existsSync("/bin/bash")) {
    return getBashShellConfig("/bin/bash");
  }

  const bashOnPath = findExecutablesOnPath("bash")[0];
  if (bashOnPath) {
    return getBashShellConfig(bashOnPath);
  }

  return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
  for (const pid of trackedDetachedChildPids) {
    killProcessTree(pid);
  }
  trackedDetachedChildPids.clear();
}

/** 进程是否仍在存活(同步探测)。kill(pid, 0) 不发信号只验存活性:存活返回 true,
 *  已死抛 ESRCH,权限不足(EPERM,进程在但属他人)按"仍在"算——那种情况我们同样杀不动。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在(已死,理想终局);EPERM 及其余 = 进程在,按存活处理。
    return (err as NodeJS.ErrnoException)?.code === "ESRCH" ? false : true;
  }
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Use taskkill on Windows to kill process tree.
    // A4-②:taskkill 不再裸 fire-and-forget——补 error/exit 监听,失败可见 + 进程仍活时降级。
    // stdio 仍 ignore、不等待(调用方是 abort/超时/退出钩子,不能阻塞),仅失败路径改变行为。
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch (err) {
      // spawn 同步抛(如 taskkill 不在 PATH)——降级直接杀主进程。
      reportError("workspace", "warn", `taskkill 启动失败,降级直接终止进程:${pid}`, err, "process_tree_kill_failed", { pid });
      killSingleProcess(pid);
      return;
    }
    // spawn 异步失败(ENOENT 等):进程没被杀,降级 + 上报。
    killer.once("error", (err) => {
      reportError("workspace", "warn", `taskkill 进程异常,降级直接终止进程:${pid}`, err, "process_tree_kill_failed", { pid });
      killSingleProcess(pid);
    });
    killer.once("exit", (code) => {
      // taskkill 退出码 0 = 树已杀;128/256(进程不存在)= 目标本就已死,也算成功。其余非零
      // (如权限不足 5)且进程仍存活 → taskkill 没杀掉,降级直接杀主进程(子进程可能残留,如实上报)。
      const gone = code === 0 || code === 128 || code === 256;
      if (gone || !processAlive(pid)) return;
      reportError("workspace", "warn", `taskkill 未能终止进程树(exit=${code}),降级直接终止主进程:${pid}`, undefined, "process_tree_kill_failed", { pid, exitCode: code ?? -1 });
      killSingleProcess(pid);
    });
  } else {
    // Use SIGKILL on Unix/Linux/Mac
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      // 按进程组杀失败(组不存在/已散)——降级只杀子进程本身;组杀抛 ESRCH 说明整组已死,
      // 仍走降级做幂等兜底(单杀一个死进程只是再抛一次 ESRCH,由 killSingleProcess 内部吞掉)。
      if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") {
        reportError("workspace", "warn", `进程组终止失败,降级终止单进程:${pid}`, err, "process_group_kill_failed", { pid });
      }
      killSingleProcess(pid);
    }
  }
}

/** 单进程降级 kill(跨平台)。杀一个已死进程抛 ESRCH 属预期,静默吞掉不打扰用户;
 *  其余(权限等)真实失败上报 warn。 */
function killSingleProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") {
      reportError("workspace", "warn", `进程终止失败:${pid}`, err, "process_kill_failed", { pid });
    }
  }
}
