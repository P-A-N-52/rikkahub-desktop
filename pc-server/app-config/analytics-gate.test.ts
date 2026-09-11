// analytics-gate.test.ts — 上报门控的行为锁。
//
// 为什么要真编译一个 exe:门控判定的正是"我是不是 bun build --compile 产物",而
// `bun test` 永远跑在源码态,普通单测**结构上无法**覆盖 exe 分支。初版门控用 argv
// 判据(假设 exe 的 argv 不含入口脚本路径),实测恰好判反——standalone 下 argv[0]
// 硬编码 "bun"、argv[1] 就是 bunfs 虚拟入口路径,于是 exe 也被当成源码态,
// 2.0.0-preview 全程零上报且无任何报错信号(看板上该版本采用曲线完全缺失)。
// 静默失效只能用"编译出来跑一下"来锁。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { analyticsEnabled } from "./analytics";

const workDir = mkdtempSync(join(tmpdir(), "rkh-analytics-gate-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("analyticsEnabled 源码态", () => {
  test("bun test / bun run server.ts 默认不上报", () => {
    delete process.env.RIKKAHUB_ANALYTICS;
    expect(analyticsEnabled()).toBe(false);
  });

  test("环境变量显式覆盖优先于形态判定", () => {
    process.env.RIKKAHUB_ANALYTICS = "1";
    expect(analyticsEnabled()).toBe(true);
    process.env.RIKKAHUB_ANALYTICS = "0";
    expect(analyticsEnabled()).toBe(false);
    delete process.env.RIKKAHUB_ANALYTICS;
  });
});

describe("analyticsEnabled 单文件 exe 态(真编译)", () => {
  // 入口放临时目录、按绝对路径 import 被测模块:不往仓库里落临时文件。
  const modulePath = resolve(import.meta.dir, "analytics.ts").replaceAll("\\", "/");
  const entryPath = join(workDir, "gate-entry.ts");
  writeFileSync(
    entryPath,
    `import { analyticsEnabled } from ${JSON.stringify(modulePath)};\n`
      + `process.stdout.write(analyticsEnabled() ? "ENABLED" : "DISABLED");\n`,
  );
  const exePath = join(workDir, process.platform === "win32" ? "gate-entry.exe" : "gate-entry");
  const built = Bun.spawnSync(["bun", "build", "--compile", entryPath, "--outfile", exePath]);
  const buildOk = built.exitCode === 0;

  function runExe(analyticsEnv?: string): string {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // 判定纯内存,但 paths.ts 在 import 时刻固化 dataDir——指向临时目录,绝不碰真实 pc-data。
      RIKKAHUB_PC_DATA_DIR: workDir,
    };
    if (analyticsEnv === undefined) delete env.RIKKAHUB_ANALYTICS;
    else env.RIKKAHUB_ANALYTICS = analyticsEnv;
    const proc = Bun.spawnSync([exePath], { env });
    expect(proc.exitCode).toBe(0);
    return new TextDecoder().decode(proc.stdout).trim();
  }

  test("编译成功(门控锁的前提)", () => {
    expect(buildOk, new TextDecoder().decode(built.stderr).slice(0, 800)).toBe(true);
  });

  test("无环境变量时上报开启——回归 2.0.0-preview 零上报", () => {
    expect(runExe()).toBe("ENABLED");
  });

  test("RIKKAHUB_ANALYTICS=0 紧急关停在 exe 形态同样生效", () => {
    expect(runExe("0")).toBe("DISABLED");
  });
});
