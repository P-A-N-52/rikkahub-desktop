import { describe, expect, test } from "bun:test";
import { createShutdown, desktopParentPid, ServerWork } from "./lifecycle";

describe("server lifetime", () => {
  test("stop refuses new work and drain waits through cancellation finally", async () => {
    const work = new ServerWork();
    let finalised = false;
    const active = work.run(async () => {
      try {
        await new Promise<void>((resolve) => work.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        await Bun.sleep(20);
        finalised = true;
      }
    });
    work.stop();
    expect(() => work.run(async () => {})).toThrow("shutting down");
    expect(finalised).toBe(false);
    await work.drain(Date.now() + 1_000);
    expect(finalised).toBe(true);
    await active;
  });

  test("concurrent shutdown calls share one promise and flush after work and processes", async () => {
    const calls: string[] = [];
    const stop = createShutdown({
      stopWork() { calls.push("stop"); },
      async drainWork() { await Bun.sleep(20); calls.push("drained"); },
      async stopProcesses() { await Bun.sleep(30); calls.push("processes"); },
      async flushState() { calls.push("flushed"); },
      onFailure() { throw new Error("unexpected failure"); },
    });
    const first = stop();
    expect(stop()).toBe(first);
    expect(calls).toEqual(["stop"]);
    expect(await first).toEqual({ ok: true, failures: [] });
    expect(calls).toEqual(["stop", "drained", "processes", "flushed"]);
    expect(stop()).toBe(first);
  });

  test("cleanup failure remains visible while persistence still runs", async () => {
    const calls: string[] = [];
    const stop = createShutdown({
      stopWork() {},
      async drainWork() {},
      async stopProcesses() { throw new Error("EPERM"); },
      async flushState() { calls.push("flushed"); },
      onFailure(phase) { calls.push(phase); },
    });
    expect(await stop()).toEqual({ ok: false, failures: ["owned processes"] });
    expect(calls).toEqual(["owned processes", "flushed"]);
  });

  test("a synchronous stop failure does not strand the shared promise", async () => {
    let cleaned = false;
    const stop = createShutdown({
      stopWork() { throw new Error("socket close failed"); },
      async drainWork() {},
      async stopProcesses() { cleaned = true; },
      async flushState() {},
      onFailure() {},
    });
    const first = stop();
    expect(stop()).toBe(first);
    expect(await first).toEqual({ ok: false, failures: ["stop work"] });
    expect(cleaned).toBe(true);
  });

  test("drain timeout is an error, not successful cancellation", async () => {
    const work = new ServerWork();
    let complete!: () => void;
    const active = work.run(() => new Promise<void>((resolve) => { complete = resolve; }));
    work.stop();
    await expect(work.drain(Date.now() + 20)).rejects.toThrow("deadline");
    complete();
    await active;
  });
});

describe("desktop parent contract", () => {
  test("only an explicitly declared macOS parent enables the watchdog", () => {
    expect(desktopParentPid(undefined, "darwin", 42)).toBeNull();
    expect(desktopParentPid("42", "linux", 42)).toBeNull();
    expect(desktopParentPid("42", "win32", 42)).toBeNull();
    expect(desktopParentPid("42", "darwin", 42)).toBe(42);
  });

  test("malformed or unrelated PID values cannot acquire ownership", () => {
    for (const value of ["", "0", "1", "-1", "42.0", "42x", " 42", "042", "9007199254740992"]) {
      expect(() => desktopParentPid(value, "darwin", 42)).toThrow();
    }
    expect(() => desktopParentPid("41", "darwin", 42)).toThrow("actual parent");
  });
});
