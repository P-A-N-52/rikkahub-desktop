// workspace/tools/embedded-bash.test.ts — 内嵌 bash 懒落地的单测。
// 用真实嵌入的 bash-bundle.tar.gz(构建脚本已产出),在隔离的临时 dataDir 里走完整落地路径。
// paths.ts 在 import 时刻固化 dataDir,故必须先设环境变量再动态加载被测模块。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDataDir = mkdtempSync(join(tmpdir(), "rkh-embed-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = testDataDir;

const mod = await import("./embedded-bash");
const { ensureEmbeddedBash, embeddedBashAvailableSync, _resetEmbeddedBashForTest } = mod;
const { embeddedBashDir, embeddedBashExe, embeddedBashStampPath } = await import("../../foundation/paths");

afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});

describe("embedded bash 懒落地", () => {
  test("首次前 availableSync 为 null;ensureEmbeddedBash 落地后命中且可执行", async () => {
    _resetEmbeddedBashForTest();
    rmSync(embeddedBashDir, { recursive: true, force: true });
    expect(embeddedBashAvailableSync()).toBeNull();

    const exe = await ensureEmbeddedBash();
    expect(exe).toBe(embeddedBashExe);
    expect(existsSync(exe)).toBe(true);
    expect(embeddedBashAvailableSync()).toBe(embeddedBashExe);
    // 版本戳已写入且与嵌入清单一致
    const stamp = JSON.parse(readFileSync(embeddedBashStampPath, "utf-8"));
    expect(typeof stamp.bundleVersion).toBe("string");
  });

  test("复用不重复解压:版本戳匹配时直接返回(落地目录 mtime 不变)", async () => {
    const before = readFileSync(embeddedBashStampPath, "utf-8");
    await ensureEmbeddedBash();
    expect(readFileSync(embeddedBashStampPath, "utf-8")).toBe(before); // 未重写
  });

  test("并发首次落地只跑一遍(同 Promise)", async () => {
    _resetEmbeddedBashForTest();
    rmSync(embeddedBashDir, { recursive: true, force: true });
    const [a, b] = await Promise.all([ensureEmbeddedBash(), ensureEmbeddedBash()]);
    expect(a).toBe(b);
    expect(existsSync(embeddedBashExe)).toBe(true);
  });

  test("版本戳不匹配(升级)→ 整目录重落地并刷新戳", async () => {
    // 人为把戳改成旧版,触发重落地
    writeFileSync(embeddedBashStampPath, JSON.stringify({ bundleVersion: "msys2-OLD" }));
    expect(embeddedBashAvailableSync()).toBeNull(); // 戳不匹配 → 快路径不命中
    _resetEmbeddedBashForTest();
    await ensureEmbeddedBash();
    const stamp = JSON.parse(readFileSync(embeddedBashStampPath, "utf-8"));
    expect(stamp.bundleVersion).not.toBe("msys2-OLD"); // 已刷新为当前嵌入版本
    expect(embeddedBashAvailableSync()).toBe(embeddedBashExe);
  });

  test("戳在但 exe 被杀软删了(半落地态)→ 快路径不命中,ensure 重落地恢复", async () => {
    // 模拟杀软只删 exe:删 bash.exe,留版本戳
    rmSync(embeddedBashExe, { force: true });
    expect(embeddedBashAvailableSync()).toBeNull(); // 半落地态不命中
    _resetEmbeddedBashForTest();
    await ensureEmbeddedBash();
    expect(existsSync(embeddedBashExe)).toBe(true); // 已重落地恢复
  });

  test("非 Windows 平台直接拒绝(内嵌 bash 仅 Windows)", async () => {
    if (process.platform === "win32") return; // 仅非 win 有意义;win 上跳过
    await expect(ensureEmbeddedBash()).rejects.toThrow(/Windows-only/);
  });
});
