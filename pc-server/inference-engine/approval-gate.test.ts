// inference-engine/approval-gate.test.ts — 在途审批等待注册表(P3)单测
// 纯内存模块,无环境依赖。语义:登记→决定/中止/接管/清扫,等待者绝不悬挂、绝不泄漏。
import { describe, expect, test } from "bun:test";
import {
  clearToolApprovalWaiters,
  pendingToolApprovalCount,
  resolveToolApproval,
  waitForToolApproval,
} from "./approval-gate";

describe("approval-gate 等待/决定汇合", () => {
  test("放行决定唤醒等待者并注销", async () => {
    const wait = waitForToolApproval("conv-a", "call-1");
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval("conv-a", "call-1", { approved: true })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: true });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("拒绝决定携带理由", async () => {
    const wait = waitForToolApproval("conv-a", "call-2");
    expect(resolveToolApproval("conv-a", "call-2", { approved: false, reason: "危险操作" })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: false, reason: "危险操作" });
  });

  test("无在途等待者时决定返回 false(孤儿审批:仅记录状态)", () => {
    expect(resolveToolApproval("conv-a", "call-ghost", { approved: true })).toBe(false);
  });

  test("中止信号 → AbortError 拒绝并注销;迟到的决定返回 false", async () => {
    const controller = new AbortController();
    const wait = waitForToolApproval("conv-b", "call-3", controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(0);
    expect(resolveToolApproval("conv-b", "call-3", { approved: true })).toBe(false);
  });

  test("预先已中止的信号 → 立即拒绝,不登记", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForToolApproval("conv-b", "call-4", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("同键重复登记:旧等待者按中止收敛,新等待者接管决定", async () => {
    const stale = waitForToolApproval("conv-c", "call-5");
    const fresh = waitForToolApproval("conv-c", "call-5");
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveToolApproval("conv-c", "call-5", { approved: true })).toBe(true);
    await expect(fresh).resolves.toEqual({ approved: true });
  });

  test("clearToolApprovalWaiters 只清目标会话,其他会话不受波及", async () => {
    const mine = waitForToolApproval("conv-d", "call-6");
    const other = waitForToolApproval("conv-e", "call-7");
    clearToolApprovalWaiters("conv-d");
    await expect(mine).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval("conv-e", "call-7", { approved: true })).toBe(true);
    await expect(other).resolves.toEqual({ approved: true });
    expect(pendingToolApprovalCount()).toBe(0);
  });
});
