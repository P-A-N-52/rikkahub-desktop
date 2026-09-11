import { describe, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { assertPortAvailable, parseDesktopDevPorts, stopProcessGroups, waitForEndpoint } from "./desktop-dev";

describe("desktop development ports", () => {
  test("defaults and explicit backend/frontend ports", () => {
    expect(parseDesktopDevPorts([])).toEqual({ backendPort: 8080, frontendPort: 5173 });
    expect(parseDesktopDevPorts(["--backend-port", "18080", "--frontend-port=15173"]))
      .toEqual({ backendPort: 18080, frontendPort: 15173 });
  });

  test("rejects missing, malformed, colliding and unknown options", () => {
    for (const args of [
      ["--backend-port"], ["--frontend-port", "0"], ["--backend-port=65536"],
      ["--backend-port=123.5"], ["--backend-port=1000=2000"], ["--port", "8000"],
      ["--backend-port", "5173"],
    ]) expect(() => parseDesktopDevPorts(args)).toThrow();
  });

  test("an occupied port is reported without touching its owner", async () => {
    const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("existing owner") });
    try {
      await expect(assertPortAvailable(owner.port!)).rejects.toThrow(`Port ${owner.port} is unavailable`);
      expect(await (await fetch(owner.url)).text()).toBe("existing owner");
    } finally {
      owner.stop(true);
    }
  });
});

describe("desktop backend readiness", () => {
  test("waits past HTTP 200 until bootstrap reports ready", async () => {
    let requests = 0;
    const backend = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ ready: ++requests >= 3, failed: false }),
    });
    try {
      await waitForEndpoint(backend.url.href, new AbortController().signal, true, 2_000);
      expect(requests).toBe(3);
    } finally {
      backend.stop(true);
    }
  });

  test("bootstrap failure ends startup with its cause", async () => {
    const backend = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ ready: false, failed: true, error: "migration failed" }),
    });
    try {
      await expect(waitForEndpoint(backend.url.href, new AbortController().signal, true))
        .rejects.toThrow("Backend bootstrap failed: migration failed");
    } finally {
      backend.stop(true);
    }
  });

  test("startup times out when a bound backend never becomes ready", async () => {
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ready: false }) });
    try {
      await expect(waitForEndpoint(backend.url.href, new AbortController().signal, true, 50))
        .rejects.toThrow("to report ready=true");
    } finally {
      backend.stop(true);
    }
  });

  test("termination cancels an in-flight readiness request", async () => {
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    const controller = new AbortController();
    const waiting = waitForEndpoint(backend.url.href, controller.signal, true);
    controller.abort(new Error("development interrupted"));
    try {
      await expect(waiting).rejects.toThrow("development interrupted");
    } finally {
      backend.stop(true);
    }
  });
});

describe("desktop process group cleanup", () => {
  const zombie = 2_000_000_001;
  const sibling = 2_000_000_002;
  const child = (pid: number) => ({ pid } as ChildProcess);
  const signalError = (code: string) => Object.assign(new Error(`fixture kill: ${code}`), { code });

  test("temporary zombie EPERM waits for ESRCH before succeeding", async () => {
    let probes = 0;
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-zombie);
      if (signal === 0 && ++probes >= 2) throw signalError("ESRCH");
      throw signalError("EPERM");
    });
    try {
      await stopProcessGroups([child(zombie)], 200);
      expect(probes).toBe(2);
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  test("one group's EPERM does not block another group's TERM or KILL", async () => {
    let killed = false;
    const termGroups: number[] = [];
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGTERM") termGroups.push(pid);
      if (pid === -zombie) throw signalError(killed ? "ESRCH" : "EPERM");
      expect(pid).toBe(-sibling);
      if (signal === "SIGKILL") killed = true;
      if (signal === 0 && killed) throw signalError("ESRCH");
      return true;
    });
    try {
      await stopProcessGroups([child(zombie), child(sibling)], 0);
      expect(termGroups).toEqual([-zombie, -sibling]);
      expect(killed).toBe(true);
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid))
        .toEqual([-zombie, -sibling]);
    } finally {
      kill.mockRestore();
    }
  });

  test("persistent EPERM is rejected with its process group and original error", async () => {
    const kill = spyOn(process, "kill").mockImplementation((pid) => {
      expect(pid).toBe(-zombie);
      throw signalError("EPERM");
    });
    try {
      await expect(stopProcessGroups([child(zombie)], 0))
        .rejects.toThrow(`PGID ${zombie}: EPERM: fixture kill: EPERM`);
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

test.skipIf(process.platform === "win32")("cleanup also terminates owned grandchildren that ignore SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", `
    const child = Bun.spawn([process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdout: 'ignore', stderr: 'ignore' });
    process.on('SIGTERM', () => {});
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (data: Buffer) => resolve(Number(data.toString().trim())));
    child.once("error", reject);
  });
  try {
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await stopProcessGroups([child], 150);
    await exited;
    const deadline = Date.now() + 2_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(grandchildPid, 0); } catch { alive = false; }
      if (alive) await Bun.sleep(50);
    }
    expect(alive).toBe(false);
  } finally {
    await stopProcessGroups([child], 0);
  }
});
