// app-errors-store.test.ts — R6-4 本地错误 30s 风暴合并语义回归。
import { beforeEach, describe, expect, test } from "bun:test";

import { useAppErrorsStore } from "~/stores/app-errors-store";
import type { AppErrorDto } from "~/types";

function entry(overrides: Partial<AppErrorDto> = {}): AppErrorDto {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    count: 1,
    severity: "error",
    domain: "internal",
    message: "boom",
    ...overrides,
  };
}

describe("reportLocalError 风暴合并", () => {
  beforeEach(() => {
    useAppErrorsStore.setState({ errors: [] });
  });

  test("新条目返回 true 并入列", () => {
    const isNew = useAppErrorsStore.getState().reportLocalError(entry());
    expect(isNew).toBe(true);
    expect(useAppErrorsStore.getState().errors).toHaveLength(1);
  });

  test("30s 内同 domain+message 合并计数,返回 false", () => {
    const base = Date.now();
    const store = useAppErrorsStore.getState();
    expect(store.reportLocalError(entry({ at: base }))).toBe(true);
    expect(store.reportLocalError(entry({ at: base + 10_000 }))).toBe(false);
    expect(store.reportLocalError(entry({ at: base + 20_000 }))).toBe(false);
    const errors = useAppErrorsStore.getState().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.count).toBe(3);
  });

  test("窗口锚定首条 at:超过 30s 产生新条目", () => {
    const base = Date.now();
    const store = useAppErrorsStore.getState();
    store.reportLocalError(entry({ at: base }));
    store.reportLocalError(entry({ at: base + 10_000 })); // 合并,不滑动窗口
    expect(store.reportLocalError(entry({ at: base + 31_000 }))).toBe(true);
    expect(useAppErrorsStore.getState().errors).toHaveLength(2);
  });

  test("不同 message 不合并", () => {
    const store = useAppErrorsStore.getState();
    store.reportLocalError(entry({ message: "a" }));
    expect(store.reportLocalError(entry({ message: "b" }))).toBe(true);
    expect(useAppErrorsStore.getState().errors).toHaveLength(2);
  });
});
