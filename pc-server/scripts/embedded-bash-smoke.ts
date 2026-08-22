// scripts/embedded-bash-smoke.ts — 内嵌 bash 兜底接线的端到端冒烟(仅 Windows 有意义)。
//   bun run scripts/embedded-bash-smoke.ts   (在 pc-server 目录下)
//
// 在隔离的临时 dataDir 里验证探测链的"内嵌兜底"档:
//   1. 无系统 bash 时 getShellConfig 抛错(并后台触发懒落地);
//   2. 落地完成后 refresh(清缓存)再探 → 命中内嵌 bash(runtime-bin 路径);
//   3. 内嵌 bash 真能执行一条命令。
// 注:系统候选探测依赖真实 PATH——本机若装了 Git Bash,第 1 步会命中系统而非抛错,
//     此时跳过抛错断言(只验内嵌可用性),保证脚本在"有/无 Git"的机器上都能跑。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ok  " + name);
  else { failures++; console.error("FAIL  " + name + (detail !== undefined ? "  →  " + JSON.stringify(detail) : "")); }
}

if (process.platform !== "win32") {
  console.log("[embedded-bash] 非 Windows,内嵌 bash 仅 Windows 用,跳过。");
  process.exit(0);
}

const testDataDir = mkdtempSync(join(tmpdir(), "rkh-embed-smoke-"));
process.env.RIKKAHUB_PC_DATA_DIR = testDataDir;

const shell = await import("../workspace/tools/shell");

console.log("[embedded-bash] 内嵌兜底冒烟,dataDir=" + testDataDir);

// 第 1 次探测:可能命中系统 Git(本机装了)或抛错(未装,后台落地)。两者都合法。
let firstShell: string | null = null;
try {
  firstShell = shell.getShellConfig().shell;
  console.log("  ok  第 1 次探测命中(系统 bash): " + firstShell);
} catch {
  console.log("  ok  第 1 次探测抛错(无系统 bash,后台已触发落地)");
}

// 等后台落地 + refresh,再探 → 无论首次如何,这次必须命中一个能用的 bash。
await new Promise((r) => setTimeout(r, 600));
shell.resetShellConfigCache();
const cfg = shell.getShellConfig();
check("refresh 后探测命中 bash", Boolean(cfg.shell), cfg.shell);

// 若系统无 bash,这次命中的应是内嵌路径;若有,命中系统路径也合法。关键是"能用"。
const isEmbedded = cfg.shell.includes("runtime-bin");
console.log(`  ..  命中${isEmbedded ? "内嵌" : "系统"} bash: ${cfg.shell}`);

// 命中的 bash 必须真能执行一条命令(echo + awk 管道,覆盖 coreutils + dll 闭包)。
const run = spawnSync(cfg.shell, [...cfg.args, 'echo smoke_ok; printf "1 2 3" | awk \'{print $2}\''], {
  encoding: "utf-8",
  timeout: 10000,
  windowsHide: true,
});
check("命中 bash 可执行 echo+awk", run.status === 0 && String(run.stdout).includes("smoke_ok") && String(run.stdout).includes("2"), { status: run.status, out: run.stdout, err: run.stderr });

rmSync(testDataDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
