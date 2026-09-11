import { describe, expect, test, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OwnedProcesses, stopBunProcess } from "./owned-processes";

const posix = process.platform !== "win32";
const serverDir = resolve(import.meta.dir, "..");

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function isolated(source: string, setup?: (dir: string) => void): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "rikka-owned-processes-"));
  try {
    setup?.(dir);
    const path = join(dir, "fixture.ts");
    writeFileSync(path, source);
    const child = Bun.spawn([process.execPath, path], {
      cwd: dir,
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: join(dir, "data"), RIKKAHUB_ANALYTICS: "0", PATH: `${dir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await result;
      if (code !== 0) throw new Error(`Fixture failed (${code}): ${stderr}\n${stdout}`);
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { clearTimeout(watchdog); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("owned process shutdown", () => {
  test.skipIf(!posix)("reaps a background group after its shell leader exits, preserving an unrelated child", async () => {
    const manager = new OwnedProcesses();
    const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const dir = mkdtempSync(join(tmpdir(), "rikka-background-"));
    const pidFile = join(dir, "descendant.pid");
    const child = spawn("/bin/sh", ["-c", 'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$1"', "fixture", pidFile], { detached: true, stdio: "ignore" });
    manager.track(child);
    try {
      await once(child, "exit");
      const descendant = Number(readFileSync(pidFile, "utf8"));
      expect(gone(descendant)).toBe(false);
      await Bun.sleep(50);
      const stop = manager.shutdown({ deadline: Date.now() + 3_000 });
      expect(manager.shutdown({ deadline: Date.now() + 4_000 })).toBe(stop);
      expect(() => manager.assertRunning()).toThrow("shutting down");
      await stop;
      expect(gone(-child.pid!)).toBe(true);
      expect(gone(descendant)).toBe(true);
      expect(gone(unrelated.pid!)).toBe(false);
    } finally {
      unrelated.kill("SIGKILL");
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("waits through transient Darwin-style EPERM until ESRCH", async () => {
    const manager = new OwnedProcesses();
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    manager.track(child);
    const nativeKill = process.kill.bind(process);
    let permissionProbes = 0;
    const probe = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -child.pid! && signal === 0 && gone(child.pid!) && permissionProbes++ < 3) {
        throw Object.assign(new Error("transient zombie group"), { code: "EPERM" });
      }
      return nativeKill(pid, signal);
    }) as typeof process.kill);
    try {
      await manager.shutdown({ deadline: Date.now() + 3_000 });
      expect(permissionProbes).toBeGreaterThanOrEqual(3);
      expect(gone(-child.pid!)).toBe(true);
    } finally { probe.mockRestore(); child.kill("SIGKILL"); }
  });

  test.skipIf(!posix)("persistent permission errors reject and do not claim cleanup", async () => {
    const manager = new OwnedProcesses();
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    manager.track(child);
    const nativeKill = process.kill.bind(process);
    const probe = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -child.pid!) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return nativeKill(pid, signal);
    }) as typeof process.kill);
    try {
      await expect(manager.shutdown({ deadline: Date.now() + 80 })).rejects.toThrow("did not stop cleanly");
      expect(gone(child.pid!)).toBe(false);
    } finally { probe.mockRestore(); child.kill("SIGKILL"); }
  });

  test("Bun child ignoring TERM is killed and awaited", async () => {
    const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdout: "pipe", stderr: "ignore" });
    await child.stdout.getReader().read();
    const start = Date.now();
    await stopBunProcess(child, { deadline: start + 2_000 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
    expect(gone(child.pid)).toBe(true);
  });

  test("completed Bun children are forgotten before shutdown and never signalled again", async () => {
    const manager = new OwnedProcesses();
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    manager.trackBun(child);
    await child.exited;
    const kill = spyOn(child, "kill");
    try {
      await manager.shutdown({ deadline: Date.now() + 1_000 });
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  test.skipIf(!posix)("Bash and a subprocess engine both retain and reap background descendants", async () => {
    const result = await isolated(`
      import { createLocalBashOperations } from ${JSON.stringify(join(serverDir, "workspace/tools/bash.ts"))};
      import { spawnSubprocess } from ${JSON.stringify(join(serverDir, "subprocess-engine/process.ts"))};
      import { shutdownOwnedProcesses } from ${JSON.stringify(join(serverDir, "foundation/owned-processes.ts"))};
      const bash = createLocalBashOperations();
      let bashPid = "";
      await bash.exec('sleep 30 </dev/null >/dev/null 2>&1 & echo $!', process.cwd(), { onData: b => { bashPid += b.toString(); } });
      let enginePid = "";
      const engine = spawnSubprocess({ cmd: "/bin/sh", args: ["-c", 'sleep 30 </dev/null >/dev/null 2>&1 & echo $!'], onStdoutChunk: b => { enginePid += new TextDecoder().decode(b); } });
      await engine.exited;
      const pids = [Number(bashPid), Number(enginePid)];
      for (const pid of pids) process.kill(pid, 0);
      await shutdownOwnedProcesses({ deadline: Date.now() + 3000 });
      const gone = pids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } });
      console.log(JSON.stringify({ gone, count: pids.length }));
    `);
    expect(result).toEqual({ gone: true, count: 2 });
  });

  test.skipIf(!posix)("TTS shutdown invalidates queued playback and awaits its active native process", async () => {
    const result = await isolated(`
      const nativeSpawn = Bun.spawn.bind(Bun);
      Bun.spawn = (command, options) => nativeSpawn(command[0] === "/usr/bin/say" ? ["espeak-ng"] : command, options);
      import { speakSystemText, shutdownSystemTts } from ${JSON.stringify(join(serverDir, "tools/platform.ts"))};
      import { existsSync, readFileSync } from "node:fs";
      const work = Promise.allSettled([speakSystemText("one"), speakSystemText("two"), speakSystemText("three")]);
      while (!existsSync("starts")) await Bun.sleep(10);
      const pid = Number(readFileSync("starts", "utf8").trim());
      await shutdownSystemTts({ deadline: Date.now() + 3000 });
      const results = await work;
      let gone = false; try { process.kill(pid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      console.log(JSON.stringify({ gone, starts: readFileSync("starts", "utf8").trim().split("\\n").length, rejected: results.filter(r => r.status === "rejected").length }));
    `, (dir) => {
      const path = join(dir, "espeak-ng");
      writeFileSync(path, `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; appendFileSync("starts", process.pid + "\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
      chmodSync(path, 0o755);
    });
    expect(result).toEqual({ gone: true, starts: 1, rejected: 3 });
  });

  test("extraction shutdown closes its queue before killed workers can pump replacements", async () => {
    const result = await isolated(`
      import { appendFileSync, existsSync, readFileSync } from "node:fs";
      if (process.env.RIKKAHUB_EXTRACT_WORKER === "1") {
        appendFileSync("starts", process.pid + "\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
      } else {
        const { ensureExtractedTextAsync, getExtractionStatus, shutdownExtractions } = await import(${JSON.stringify(join(serverDir, "files/extraction.ts"))});
        const entries = [1, 2, 3, 4].map(id => ({ id, path: "fixture.pdf", fileName: "fixture.pdf", mime: "application/pdf", size: 1 }));
        for (const entry of entries) ensureExtractedTextAsync(entry);
        while (!existsSync("starts") || readFileSync("starts", "utf8").trim().split("\\n").length < 2) await Bun.sleep(10);
        const stop = shutdownExtractions({ deadline: Date.now() + 3000 });
        ensureExtractedTextAsync({ ...entries[0], id: 5 });
        await stop;
        const pids = readFileSync("starts", "utf8").trim().split("\\n").map(Number);
        const gone = pids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } });
        console.log(JSON.stringify({ gone, starts: pids.length, states: entries.map(e => getExtractionStatus(e).status) }));
      }
    `);
    expect(result).toEqual({ gone: true, starts: 2, states: ["failed", "failed", "failed", "failed"] });
  });
});
