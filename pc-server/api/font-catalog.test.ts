import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FontEntry } from "../foundation/types";
import { waitForServerReady } from "../test-utils/e2e-server";

type HelperMode = "fail" | "success" | "wait";
type Catalog = { builtin: FontEntry[]; custom: FontEntry[]; system: FontEntry[] };
const serverEntry = join(import.meta.dir, "..", "server.ts");
const families = ["Fixture Builtin", "fixture custom", "System Fixture", "System Fixture"];

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Font fixture did not reach the expected state");
    await Bun.sleep(10);
  }
}

async function fixture(mode: HelperMode) {
  const dir = mkdtempSync(join(tmpdir(), "rkh-font-catalog-"));
  const dataDir = join(dir, "data");
  const resources = join(dir, "resources");
  const control = join(dir, "control.json");
  const starts = join(dir, "starts.jsonl");
  const helper = join(dir, "font helper");
  const setMode = (next: HelperMode) => writeFileSync(control, JSON.stringify({ mode: next, families }));
  for (const path of [join(dataDir, "fonts"), join(resources, "fonts"), join(resources, "icons"), join(resources, "web-ui/build/client")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(resources, "web-ui/build/client/index.html"), "<!doctype html><title>Font fixture</title>");
  writeFileSync(join(resources, "fonts/manifest.json"), JSON.stringify({
    "builtin.ttf": { family: "Fixture Builtin", label: "Fixture Builtin" },
  }));
  writeFileSync(join(resources, "fonts/builtin.ttf"), "catalog fixture; no font parsing or rendering");
  writeFileSync(join(dataDir, "fonts/Fixture Custom.ttf"), "catalog fixture; no font parsing or rendering");
  writeFileSync(join(dataDir, "models-dev-cache.json"), "{}");
  writeFileSync(join(dataDir, "state.json"), JSON.stringify({ settings: { proxyConfig: { mode: "direct" } } }));
  setMode(mode);
  writeFileSync(helper, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
if (!process.argv.includes("--list-system-fonts")) process.exit(9);
const config = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
appendFileSync(${JSON.stringify(starts)}, JSON.stringify({ pid: process.pid, mode: config.mode }) + "\\n");
if (config.mode === "fail") process.exit(7);
if (config.mode === "wait") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else console.log(JSON.stringify(config.families));
`);
  chmodSync(helper, 0o700);

  // Reserve an OS-chosen port, then require that exact port; never reuse a QA port
  // or let a busy-port fallback accidentally target another server instance.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const env: NodeJS.ProcessEnv = {
    ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_RESOURCE_DIR: resources,
    RIKKAHUB_FONT_HELPER: helper, RIKKAHUB_ANALYTICS: "0", RIKKAHUB_CONTAINER: "0",
  };
  delete env.RIKKAHUB_PARENT_PID;
  const proc = Bun.spawn([process.execPath, serverEntry, "--port", String(port), "--strict-port", "--host", "127.0.0.1", "--no-open"], {
    cwd: dir, env, stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const watchdog = setTimeout(() => proc.kill("SIGKILL"), 25_000);
  const reads = () => existsSync(starts)
    ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; mode: HelperMode })
    : [];
  const cleanup = async () => {
    clearTimeout(watchdog);
    proc.kill("SIGKILL");
    await proc.exited;
    for (const entry of reads()) {
      if (!gone(entry.pid)) process.kill(entry.pid, "SIGKILL");
    }
    await until(() => reads().every((entry) => gone(entry.pid)));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const bound = await waitForServerReady(proc);
    expect(bound).toBe(port!);
    return {
      proc, reads, setMode, cleanup,
      get: (path: string, timeoutMs = 5_000) => fetch(`http://127.0.0.1:${bound}/api/${path}`, { signal: AbortSignal.timeout(timeoutMs) }),
      shutdown: async () => {
        const response = await fetch(`http://127.0.0.1:${bound}/api/app/shutdown`, { method: "POST", signal: AbortSignal.timeout(10_000) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(await proc.exited).toBe(0);
      },
    };
  } catch (error) {
    await cleanup();
    throw new Error(`Font fixture startup failed: ${await stderr}`, { cause: error });
  }
}

describe.skipIf(process.platform !== "darwin")("font catalog HTTP API with a native helper fixture", () => {
  test("fast local catalog bypasses enumeration; errors remain errors, retry succeeds and successful names are cached", async () => {
    const f = await fixture("fail");
    try {
      const localResponse = await f.get("fonts/list?system=0", 1_000);
      expect(localResponse.status).toBe(200);
      const local = await localResponse.json() as Catalog;
      expect(local.builtin.map((entry) => entry.cssName)).toEqual(["Fixture Builtin"]);
      expect(local.custom.map((entry) => entry.cssName)).toEqual(["Fixture Custom"]);
      expect(local.system).toEqual([]);
      expect(f.reads()).toEqual([]);

      const failed = await f.get("fonts/system");
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "System font query exited with 7", code: 500 });
      expect(f.reads()).toHaveLength(1);

      f.setMode("success");
      const retried = await f.get("fonts/system");
      expect(retried.status).toBe(200);
      const detected = await retried.json() as Pick<Catalog, "system">;
      expect(detected.system.map((entry) => entry.cssName).sort()).toEqual(["Fixture Builtin", "System Fixture", "fixture custom"].sort());
      expect(detected.system.every((entry) => entry.source === "system" && entry.weights.length === 0)).toBe(true);
      expect(f.reads()).toHaveLength(2);

      f.setMode("fail");
      const cached = await f.get("fonts/system");
      expect(cached.status).toBe(200);
      expect(await cached.json()).toEqual(detected);
      const legacy = await f.get("fonts/list");
      expect(legacy.status).toBe(200);
      const full = await legacy.json() as Catalog;
      expect(full.builtin).toEqual(local.builtin);
      expect(full.custom).toEqual(local.custom);
      expect(full.system.map((entry) => entry.cssName)).toEqual(["System Fixture"]);
      expect(f.reads()).toHaveLength(2);
      await f.shutdown();
    } finally { await f.cleanup(); }
  }, 30_000);

  test("a pending font query does not block local catalog access and HTTP shutdown reaps its helper", async () => {
    const f = await fixture("wait");
    try {
      const pending = f.get("fonts/system", 10_000);
      await until(() => f.reads().length === 1);
      const pid = f.reads()[0]!.pid;
      expect(gone(pid)).toBe(false);
      const local = await f.get("fonts/list?system=0", 1_000);
      expect(local.status).toBe(200);
      expect((await local.json() as Catalog).system).toEqual([]);
      expect(f.reads()).toHaveLength(1);
      await f.shutdown();
      const interrupted = await pending;
      expect(interrupted.status).toBe(500);
      expect(await interrupted.json()).toEqual({ error: "System font query exited with SIGKILL", code: 500 });
      expect(gone(pid)).toBe(true);
    } finally { await f.cleanup(); }
  }, 30_000);
});
