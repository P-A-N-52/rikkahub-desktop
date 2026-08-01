// 统一错误上报通道单测(P2-1 批1):环形缓冲、风暴合并、注入广播、广播故障隔离。
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { clearAppErrors, initAppErrorBroadcast, installProcessSafetyNet, recentAppErrors, reportError } from "./app-errors";

// 环形缓冲是模块级全局:beforeEach 也清一次,隔离先跑的其他测试文件遗留的上报条目(M4-0)。
beforeEach(() => {
  clearAppErrors();
  initAppErrorBroadcast(() => {});
});

afterEach(() => {
  clearAppErrors();
  initAppErrorBroadcast(() => {});
  setSystemTime();
});

describe("reportError", () => {
  test("条目进入快照,新→旧排序,detail 取 Error stack", () => {
    const err = new Error("boom");
    reportError("backup", "warn", "第一条");
    reportError("provider", "error", "第二条", err);
    const recent = recentAppErrors();
    expect(recent.map((e) => e.message)).toEqual(["第二条", "第一条"]);
    expect(recent[0]!.severity).toBe("error");
    expect(recent[0]!.domain).toBe("provider");
    expect(recent[0]!.count).toBe(1);
    expect(recent[0]!.detail).toContain("boom");
  });

  test("30s 窗口内同 domain+message 合并计数,不新增条目、不重复广播", () => {
    const broadcasts: string[] = [];
    initAppErrorBroadcast((entry) => broadcasts.push(entry.message));
    setSystemTime(new Date(1_000_000));
    reportError("network", "warn", "抖动");
    setSystemTime(new Date(1_000_000 + 10_000));
    reportError("network", "warn", "抖动");
    reportError("network", "warn", "抖动");
    const recent = recentAppErrors();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.count).toBe(3);
    expect(recent[0]!.at).toBe(1_000_000 + 10_000);
    expect(broadcasts).toEqual(["抖动"]);
  });

  test("窗口过期后同 message 生成新条目并再次广播", () => {
    const broadcasts: string[] = [];
    initAppErrorBroadcast((entry) => broadcasts.push(entry.message));
    setSystemTime(new Date(1_000_000));
    reportError("network", "warn", "抖动");
    setSystemTime(new Date(1_000_000 + 31_000));
    reportError("network", "warn", "抖动");
    expect(recentAppErrors()).toHaveLength(2);
    expect(broadcasts).toEqual(["抖动", "抖动"]);
  });

  test("同 message 不同 domain 不合并", () => {
    setSystemTime(new Date(1_000_000));
    reportError("network", "warn", "失败");
    reportError("backup", "warn", "失败");
    expect(recentAppErrors()).toHaveLength(2);
  });

  test("带码条目按 码+参数 合并:同码同参合并,同码不同参不合并,code/params 随条目下发", () => {
    setSystemTime(new Date(1_000_000));
    reportError("internal", "error", "接口处理异常：/api/a", undefined, "api_exception", { path: "/api/a" });
    reportError("internal", "error", "接口处理异常：/api/a", undefined, "api_exception", { path: "/api/a" });
    reportError("internal", "error", "接口处理异常：/api/b", undefined, "api_exception", { path: "/api/b" });
    const recent = recentAppErrors();
    expect(recent).toHaveLength(2);
    expect(recent[1]!.count).toBe(2);
    expect(recent[1]!.code).toBe("api_exception");
    expect(recent[1]!.params).toEqual({ path: "/api/a" });
  });

  test("环形缓冲上限 200 条,溢出丢最旧", () => {
    setSystemTime(new Date(1_000_000));
    for (let i = 0; i < 205; i++) {
      // 每条 message 不同避免合并;时间推进避免窗口影响
      reportError("internal", "info", `条目${i}`);
    }
    const recent = recentAppErrors();
    expect(recent).toHaveLength(200);
    expect(recent[0]!.message).toBe("条目204");
    expect(recent[199]!.message).toBe("条目5");
  });

  test("广播回调抛错不污染上报路径", () => {
    initAppErrorBroadcast(() => {
      throw new Error("坏客户端");
    });
    expect(() => reportError("internal", "info", "安全")).not.toThrow();
    expect(recentAppErrors()).toHaveLength(1);
  });
});

// 全面审查 4-2 回归:进程级兜底把顶层异常导入错误中心而非退出进程。
// 直接调用注册的 handler 验证(在测试进程里真抛顶层异常会干扰 test runner)。
describe("installProcessSafetyNet", () => {
  test("注册两类 handler,handler 上报错误中心且不抛错;幂等不重复注册", () => {
    const beforeEx = process.listeners("uncaughtException").length;
    const beforeRej = process.listeners("unhandledRejection").length;
    installProcessSafetyNet();
    installProcessSafetyNet(); // 幂等
    const exAdded = process.listeners("uncaughtException").slice(beforeEx);
    const rejAdded = process.listeners("unhandledRejection").slice(beforeRej);
    try {
      expect(exAdded).toHaveLength(1);
      expect(rejAdded).toHaveLength(1);
      expect(() => (exAdded[0] as (e: Error) => void)(new Error("定时器炸了"))).not.toThrow();
      expect(() => (rejAdded[0] as (r: unknown) => void)("游离 promise 拒绝")).not.toThrow();
      const msgs = recentAppErrors().map((e) => e.message);
      expect(msgs.some((m) => m.includes("未捕获异常"))).toBe(true);
      expect(msgs.some((m) => m.includes("Promise 拒绝"))).toBe(true);
    } finally {
      for (const fn of exAdded) process.removeListener("uncaughtException", fn as never);
      for (const fn of rejAdded) process.removeListener("unhandledRejection", fn as never);
    }
  });
});
