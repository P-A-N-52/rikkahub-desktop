// R1 取证:boot-trace 启动/崩溃黑匣子(行业标准"残留即异常退出"状态机)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendBootTraceIn,
  beginBootTraceIn,
  capturePreviousBootTraceIn,
  cleanExitIn,
  readPreviousCrashLogIn,
} from "./boot-trace";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rikka-boot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PENDING = () => join(dir, "server.boot.pending.log");
const LOG = () => join(dir, "server.log");

/** 模拟一次完整会话:启动 → 打里程碑。返回后 pending 在场(会话进行中)。 */
function startSession(milestones: string[]): void {
  capturePreviousBootTraceIn(dir); // 启动最早期:转存上次残留(若有)
  beginBootTraceIn(dir);
  for (const m of milestones) appendBootTraceIn(dir, m);
}

describe("boot-trace 取证黑匣子", () => {
  test("正常路径:启动 → 干净退出 → 不留任何文件", () => {
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);
    expect(existsSync(PENDING())).toBe(true); // 会话进行中 pending 在场

    cleanExitIn(dir); // 干净退出
    expect(existsSync(PENDING())).toBe(false);
    expect(existsSync(LOG())).toBe(false);

    // 下次启动:无残留,capture 不转存
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("启动期崩溃(issue1):进程没走到干净退出,pending 残留 → 下次启动转存 server.log 并判读区间", () => {
    // 上一次:只走到"已拿数据目录锁",随后进程蒸发(没 cleanExitIn)
    startSession(["进程拉起", "已拿数据目录锁"]);
    // (模拟崩溃:直接结束,不调 cleanExitIn)

    // 本次启动 capture
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(existsSync(PENDING())).toBe(false); // 旧 pending 已转存清除
    const log = readPreviousCrashLogIn(dir);
    expect(log).not.toBeNull();
    expect(log!).toContain("已拿数据目录锁");
    expect(log!).toContain("最后完成「已拿数据目录锁」");
  });

  test("关键 corner:直接关机 → server.log 短暂残留;下次正常启动+正常退出 → 日志归零(不打扰用户)", () => {
    // 上一次:正常运行中被关机(没走干净退出)
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);
    // (关机 = 进程蒸发,没 cleanExitIn)

    // 下次启动:转存残留 → server.log 出现(此刻它躺着,用户若此刻翻文件夹会看到)
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(readPreviousCrashLogIn(dir)).not.toBeNull();

    // 本次正常跑、正常退出
    beginBootTraceIn(dir);
    appendBootTraceIn(dir, "进程拉起");
    cleanExitIn(dir); // 干净退出连带清掉 server.log
    expect(existsSync(PENDING())).toBe(false);
    expect(existsSync(LOG())).toBe(false); // 假报警归零

    // 再下次启动:一切干净,错误中心不再有这条
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("运行期崩溃留证:bootstrap 完成后进程蒸发,pending 仍含全部里程碑", () => {
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);
    // 运行期崩溃(没 cleanExitIn)
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    const log = readPreviousCrashLogIn(dir);
    expect(log!).toContain("bootstrap 完成");
    expect(log!).toContain("最后完成「bootstrap 完成」"); // 指针指到运行期
  });

  test("极早期崩溃:pending 无任何里程碑 → 判读为“进程拉起之前”", () => {
    beginBootTraceIn(dir); // 只写了头
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(readPreviousCrashLogIn(dir)!).toContain("进程拉起”之前");
  });

  test("幂等与边界:重复 cleanExit / 从未 begin 的 capture 都不报错", () => {
    cleanExitIn(dir);
    cleanExitIn(dir);
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("隐私边界:日志只含里程碑/进程元信息,不含会话内容/密钥字段", () => {
    startSession(["进程拉起", "端口已绑定"]);
    capturePreviousBootTraceIn(dir);
    const log = readPreviousCrashLogIn(dir)!;
    expect(log).not.toMatch(/apiKey|api_key|messages|conversation|content|prompt/i);
  });
});
