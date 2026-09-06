// use-autosave-draft.test.ts — R8-2 三件套语义回归(核心:保存窗口内键击不丢)。
import { describe, expect, test } from "bun:test";

import { createAutosaveController } from "~/hooks/use-autosave-draft";

/** 假定时器:手动触发到期回调,断言重排/清理行为。 */
function fakeScheduler() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    set(fn: () => void, _ms: number): number {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clear(id: number) {
      pending.delete(id);
    },
    /** 触发所有当前待发定时器(触发前先摘除,模拟一次到期)。 */
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get count() {
      return pending.size;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((res) => setTimeout(res, 0));

describe("createAutosaveController", () => {
  test("编辑→防抖到期→保存一次,完成后干净", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.markDirty();
    expect(scheduler.count).toBe(1);
    scheduler.fire();
    await tick();
    expect(saves).toBe(1);
    expect(ctl.isDirty()).toBe(false);
  });

  test("连续编辑重排定时器,只保存一次", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.markDirty();
    ctl.markDirty();
    ctl.markDirty();
    expect(scheduler.count).toBe(1); // 每次 markDirty 清旧排新
    scheduler.fire();
    await tick();
    expect(saves).toBe(1);
  });

  test("核心回归:保存窗口内的编辑保持脏并自动补排,第二轮保存拿到最新草稿", async () => {
    const scheduler = fakeScheduler();
    const savedValues: string[] = [];
    let value = "a";
    const gate = deferred();
    let block = true;
    const ctl = createAutosaveController(async () => {
      const snapshot = value;
      if (block) await gate.promise;
      savedValues.push(snapshot);
    }, { scheduler });

    ctl.markDirty();
    scheduler.fire(); // 保存发起(在 gate 上悬着)
    await tick();

    // 保存窗口内的键击
    value = "ab";
    ctl.markDirty();
    expect(ctl.isDirty()).toBe(true);

    // 窗口内键击排的防抖先到期:在飞未结束 → 跳过,等完成回调补排
    scheduler.fire();
    await tick();
    expect(savedValues).toEqual([]);

    block = false;
    gate.resolve();
    await tick();
    expect(savedValues).toEqual(["a"]);
    // 旧样板在这里无条件置干净把键击抹掉;三件套要求仍脏 + 已补排
    expect(ctl.isDirty()).toBe(true);
    expect(scheduler.count).toBe(1);

    scheduler.fire();
    await tick();
    expect(savedValues).toEqual(["a", "ab"]);
    expect(ctl.isDirty()).toBe(false);
  });

  test("保存失败:保持脏,不自动重排,下一次编辑重试", async () => {
    const scheduler = fakeScheduler();
    let attempts = 0;
    let fail = true;
    const errors: unknown[] = [];
    const ctl = createAutosaveController(
      async () => {
        attempts++;
        if (fail) throw new Error("boom");
      },
      { scheduler, onSaveError: (error) => errors.push(error) },
    );

    ctl.markDirty();
    scheduler.fire();
    await tick();
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(ctl.isDirty()).toBe(true);
    expect(scheduler.count).toBe(0); // 不自动重排,避免持续失败风暴

    fail = false;
    ctl.markDirty();
    scheduler.fire();
    await tick();
    expect(attempts).toBe(2);
    expect(ctl.isDirty()).toBe(false);
  });

  test("reset:防抖窗口内的脏编辑先补发一次,再清态(切换条目不丢字)", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.markDirty();
    ctl.reset(); // 700ms 窗口内切换条目:旧样板直接丢弃 → 静默丢字
    await tick();
    expect(saves).toBe(1);
    expect(ctl.isDirty()).toBe(false);
    expect(scheduler.count).toBe(0);
    scheduler.fire();
    await tick();
    expect(saves).toBe(1); // 定时器已清,不重复保存
  });

  test("reset:干净状态下不发保存,只清定时器", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.reset();
    await tick();
    expect(saves).toBe(0);
    expect(scheduler.count).toBe(0);
  });

  test("reset:已有在飞保存时不重复发起(完成回调自行收尾)", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const gate = deferred();
    const ctl = createAutosaveController(async () => {
      saves++;
      await gate.promise;
    }, { scheduler });

    ctl.markDirty();
    scheduler.fire(); // 第一笔在飞
    await tick();
    ctl.markDirty(); // 在飞窗口内的编辑
    ctl.reset(); // 切换条目:不得并发第二笔
    expect(saves).toBe(1);
    gate.resolve();
    await tick();
    expect(saves).toBe(1);
  });

  test("saveNow 与在飞保存串行化,完成后按需补发", async () => {
    const scheduler = fakeScheduler();
    const savedValues: string[] = [];
    let value = "a";
    const gate = deferred();
    let block = true;
    const ctl = createAutosaveController(async () => {
      const snapshot = value;
      if (block) await gate.promise;
      savedValues.push(snapshot);
    }, { scheduler });

    ctl.markDirty();
    scheduler.fire(); // 第一笔在飞
    await tick();
    value = "ab";
    ctl.markDirty();

    const manual = ctl.saveNow(); // 应等第一笔收尾再补发第二笔
    block = false;
    gate.resolve();
    await manual;
    expect(savedValues).toEqual(["a", "ab"]);
    expect(ctl.isDirty()).toBe(false);
  });

  test("saveNow:不脏且非 force 跳过;force 无条件保存", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    await ctl.saveNow();
    expect(saves).toBe(0);
    await ctl.saveNow({ force: true });
    expect(saves).toBe(1);
  });

  test("saveNow 失败向调用方抛出并保持脏", async () => {
    const scheduler = fakeScheduler();
    const ctl = createAutosaveController(async () => {
      throw new Error("boom");
    }, { scheduler });

    ctl.markDirty();
    expect(ctl.saveNow()).rejects.toThrow("boom");
    await tick();
    expect(ctl.isDirty()).toBe(true);
  });

  test("flushOnTeardown:卸载时脏数据尽力补发(修复切页即丢)", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.markDirty();
    ctl.flushOnTeardown();
    await tick();
    expect(saves).toBe(1);
    expect(scheduler.count).toBe(0);
  });

  test("discard:脏编辑直接丢弃绝不补发(删除前调用,防已删实体复活)", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const ctl = createAutosaveController(async () => {
      saves++;
    }, { scheduler });

    ctl.markDirty();
    await ctl.discard();
    expect(saves).toBe(0);
    expect(ctl.isDirty()).toBe(false);
    expect(scheduler.count).toBe(0);
    scheduler.fire();
    await tick();
    expect(saves).toBe(0);
  });

  test("discard:等待在飞保存收尾(DELETE 不与迟到 POST 乱序),且不补发第二笔", async () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const gate = deferred();
    const ctl = createAutosaveController(async () => {
      saves++;
      await gate.promise;
    }, { scheduler });

    ctl.markDirty();
    scheduler.fire(); // 第一笔在飞
    await tick();
    ctl.markDirty(); // 在飞窗口内的编辑:discard 后不得补发

    let settled = false;
    const discarding = ctl.discard().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false); // 在飞未收尾,discard 挂起

    gate.resolve();
    await discarding;
    await tick();
    expect(saves).toBe(1); // 只有那笔在飞,无补发
    expect(ctl.isDirty()).toBe(false);
    expect(scheduler.count).toBe(0);
  });

  test("reset:补发失败不把脏标记留给新实体(isDirty 守卫不被卡住)", async () => {
    const scheduler = fakeScheduler();
    const errors: unknown[] = [];
    const ctl = createAutosaveController(
      async () => {
        throw new Error("boom");
      },
      { scheduler, onSaveError: (error) => errors.push(error) },
    );

    ctl.markDirty();
    ctl.reset(); // 补发失败
    await tick();
    expect(errors).toHaveLength(1);
    expect(ctl.isDirty()).toBe(false); // 失败是旧实体的遗憾,新实体不背脏
  });

  // 域7-1(交互审查 3A):status 机是 <AutosaveStatusRow/> 三态行的唯一数据源。
  // 锁定关键迁移——失败必须落 failed(用户要看到"保存失败"而不是假"已保存")。
  test("域7-1 status 机:idle→pending→saving→saved;失败→failed;saveNow 重试回 saved", async () => {
    const scheduler = fakeScheduler();
    const seen: string[] = [];
    let fail = false;
    const ctl = createAutosaveController(
      async () => {
        if (fail) throw new Error("offline");
      },
      { scheduler, onStatusChange: (s) => seen.push(s), onSaveError: () => {} },
    );

    ctl.markDirty();
    expect(seen).toEqual(["pending"]); // 置脏即 pending(防抖窗口内)
    scheduler.fire();
    await tick();
    expect(seen).toEqual(["pending", "saving", "saved"]); // 成功走完整链

    fail = true;
    ctl.markDirty();
    scheduler.fire();
    await tick();
    expect(seen.at(-1)).toBe("failed"); // 失败必须落 failed——假"已保存"的根治点

    fail = false;
    await ctl.saveNow(); // 状态行"点击重试"路径
    expect(seen.at(-1)).toBe("saved");
  });
});
