// 类型检查唯一入口(bun run typecheck)。
//
// 背景:pc-server 直接 import vendored pi 源码,tsc 单程序会把 pi 全图拉进来,
// 用我们更严的 flags(noUnusedLocals 等)复检 pi 内部代码,产生与我们无关的噪音
// (pi 补丁纪律:仅允许带 [RIKKAHUB PATCH] 标记的功能补丁,禁止为消音改它的源码;
// 其内部质量由上游 CI 以自家 tsconfig 把关)。
// 因此:滤除位于 pi/ 内部文件上的诊断,只对"我们侧文件 + 我们对 pi 的使用"负责——
// 我们侧任何诊断(含调用 pi API 的类型错误)照常失败。改动 pi 内文件后,须裸跑
// bunx tsc 人工核对该文件无新增诊断(过滤会吞掉补丁自身的类型错误)。
import { join } from "node:path";

const pcServerDir = join(import.meta.dir, "..");

const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--pretty", "false"], {
	cwd: pcServerDir,
	stdout: "pipe",
	stderr: "pipe",
});

const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
const diagnosticStart = /^(.+?)\(\d+,\d+\): (error|warning) TS\d+:/;

let keptErrorCount = 0;
let droppedCount = 0;
let droppingContinuation = false;
const keptLines: string[] = [];

for (const line of output.split(/\r?\n/)) {
	const match = line.match(diagnosticStart);
	if (match) {
		const normalizedFile = match[1]!.replaceAll("\\", "/");
		const isInsidePi = normalizedFile.startsWith("../pi/") || normalizedFile.includes("/pi/packages/");
		droppingContinuation = isInsidePi;
		if (isInsidePi) {
			droppedCount++;
			continue;
		}
		if (match[2] === "error") keptErrorCount++;
		keptLines.push(line);
		continue;
	}
	// 缩进行是上一条诊断的补充说明,跟随上一条的去留。
	if (droppingContinuation && (line.startsWith(" ") || line.startsWith("\t"))) continue;
	droppingContinuation = false;
	if (line.trim() !== "") keptLines.push(line);
}

if (keptLines.length > 0) console.log(keptLines.join("\n"));
console.log(`[typecheck] 我们侧错误: ${keptErrorCount} | 已滤除 pi 内部诊断: ${droppedCount}`);
process.exit(keptErrorCount > 0 ? 1 : 0);
