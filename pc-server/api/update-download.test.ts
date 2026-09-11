import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForServerReady } from "../test-utils/e2e-server";

interface UpdateInfo {
  latest: string; isNewer: boolean; isSkipped: boolean; platform: string; architecture: string;
  releaseRepo: string; downloadUrl: string; fileName: string; size: number; sha256: string; cachedInstallerPath: string | null;
}
interface Event { type: string; path?: string; size?: number; message?: string; }

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rkh-update-api-")));
  const env = { ...process.env, RIKKAHUB_PC_DATA_DIR: dir, RIKKAHUB_ANALYTICS: "0", RIKKAHUB_CONTAINER: "0" };
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../test-utils/update-route-fixture.ts")], { env, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
  const cleanup = async () => { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; rmSync(dir, { recursive: true, force: true }); };
  try {
    const port = await waitForServerReady(proc, 5_000);
    const base = `http://127.0.0.1:${port}`;
    const get = (path: string) => fetch(`${base}/${path}`, { signal: AbortSignal.timeout(4_000), proxy: "" });
    const post = (path: string, body: object, signal = AbortSignal.timeout(4_000)) => fetch(`${base}/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal, proxy: "",
    });
    const check = async () => { const response = await get("api/update/check"); expect(response.status).toBe(200); return await response.json() as UpdateInfo; };
    return { dir, proc, cleanup, get, post, check,
      setMode: (mode: string) => post("fixture/mode", { mode }),
      download: (info: UpdateInfo, signal?: AbortSignal) => post("api/update/download", {
        url: info.downloadUrl, fileName: info.fileName, version: info.latest, size: info.size, sha256: info.sha256,
      }, signal),
    };
  } catch (cause) { await cleanup(); throw new Error(`Update fixture did not start: ${await stderr}`, { cause }); }
}

async function events(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Event);
}

describe.skipIf(process.platform !== "darwin")("macOS update HTTP contract", () => {
  test("complete DMG returns its own path, cache and skip survive repeated checks, and Linux apply is refused", async () => {
    const f = await fixture();
    try {
      const info = await f.check();
      expect(info.platform).toBe("mac");
      expect(info.architecture).toBe(process.arch);
      expect(info.isNewer).toBe(true);
      expect(info.cachedInstallerPath).toBeNull();
      const received = await events(await f.download(info));
      expect(received.some((event) => event.type === "error")).toBe(false);
      const done = received.at(-1)!;
      expect(done).toEqual({ type: "done", path: join(f.dir, "updates", info.fileName), size: info.size });
      expect(readFileSync(done.path!, "utf8")).toContain("not a tar archive");
      expect(readdirSync(join(f.dir, "updates")).sort()).toEqual([info.fileName, `${info.fileName}.completed.json`].sort());
      expect((await f.check()).cachedInstallerPath).toBe(done.path!);
      const apply = await f.post("api/update/apply", { path: done.path });
      expect(apply.status).toBe(400);
      expect(await apply.json()).toMatchObject({ error: "仅 Linux 支持原地更新" });
      expect((await f.post("api/update/skip", { version: info.latest })).status).toBe(200);
      expect(await f.check()).toMatchObject({ isSkipped: true, cachedInstallerPath: null });
      expect(readFileSync(join(f.dir, "skip-version.txt"), "utf8")).toBe(info.latest);
      await f.setMode("missing");
      expect(await f.check()).toMatchObject({ downloadUrl: "", fileName: "", cachedInstallerPath: null });
    } finally { await f.cleanup(); }
  }, 15_000);

  test("download errors return an error event and never expose partial cache", async () => {
    const f = await fixture();
    try {
      const info = await f.check();
      for (const mode of ["truncated", "http-error"]) {
        await f.setMode(mode);
        const received = await events(await f.download(info));
        expect(received.at(-1)?.type).toBe("error");
        expect(received.some((event) => event.type === "done")).toBe(false);
        expect(readdirSync(join(f.dir, "updates"))).toEqual([]);
        expect((await f.check()).cachedInstallerPath).toBeNull();
      }
      const invalid = await f.post("api/update/download", { url: info.downloadUrl, fileName: info.fileName });
      expect(invalid.status).toBe(400);
    } finally { await f.cleanup(); }
  }, 15_000);

  test("client cancellation and shared shutdown each abort the asset stream and clean partial files", async () => {
    const f = await fixture();
    try {
      const info = await f.check();
      await f.setMode("wait");
      const abort = new AbortController();
      const response = await f.download(info, abort.signal);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      abort.abort();
      await reader.cancel().catch(() => {});
      for (let n = 0; n < 100 && readdirSync(join(f.dir, "updates")).length; n++) await Bun.sleep(10);
      expect(readdirSync(join(f.dir, "updates"))).toEqual([]);
      expect(await (await f.get("fixture/status")).json()).toMatchObject({ canceled: 1 });

      const second = await f.download(info);
      const secondReader = second.body!.getReader();
      expect((await secondReader.read()).done).toBe(false);
      expect(existsSync(join(f.dir, "updates", info.fileName))).toBe(false);
      const stop = await f.post("fixture/stop", {});
      expect(stop.status).toBe(200);
      await secondReader.cancel().catch(() => {});
      expect(await f.proc.exited).toBe(0);
      expect(readdirSync(join(f.dir, "updates"))).toEqual([]);
    } finally { await f.cleanup(); }
  }, 15_000);
});
