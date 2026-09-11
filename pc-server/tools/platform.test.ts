import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each fixture has its own module state, clipboard file and real child processes.
// Native commands are intercepted before spawning, so these tests never touch
// the user's pasteboard or speakers and do not require installed voice packages.
const fakeNativeSource = `
  import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
  const command = JSON.parse(process.argv[2]);
  const text = await Bun.stdin.text();
  const mode = process.argv[3];
  const outputFlag = command.includes("-o") ? "-o" : "-w";
  const output = command.includes(outputFlag) ? command[command.indexOf(outputFlag) + 1] : undefined;
  if (output && mode !== "missing") {
    const wav = Buffer.alloc(48);
    wav.write("RIFF", 0); wav.writeUInt32LE(40, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
    wav.writeUInt32LE(4, 40); wav.writeInt16LE(100, 44); wav.writeInt16LE(-100, 46);
    writeFileSync(output, mode === "invalid" ? "FORM not a WAV file" : wav);
  }
  appendFileSync("calls.jsonl", JSON.stringify({ command, text, locale: process.env.LC_ALL, pid: process.pid }) + "\\n");
  if (mode === "wait") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (mode === "fail") {
    console.error("native fixture failed"); process.exit(7);
  } else if (command[0].endsWith("pbcopy") || command.at(-1).includes("Set-Clipboard")) {
    writeFileSync("clipboard", text);
  } else if (command[0].endsWith("pbpaste") || command.at(-1).includes("Get-Clipboard")) {
    process.stdout.write(existsSync("clipboard") ? readFileSync("clipboard") : "");
  }
`;

async function isolated(source: string, platform: NodeJS.Platform = "darwin"): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "rikka-platform-"));
  const nativeTemp = join(dir, "native-temp");
  mkdirSync(nativeTemp);
  const fake = join(dir, "fake-native.ts");
  const fixture = join(dir, "fixture.ts");
  writeFileSync(fake, fakeNativeSource);
  writeFileSync(fixture, `
    import { existsSync, readFileSync, readdirSync } from "node:fs";
    const nativeSpawn = Bun.spawn.bind(Bun);
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    Bun.spawn = (command, options) => nativeSpawn([process.execPath, ${JSON.stringify(fake)}, JSON.stringify(command), process.env.FAKE_MODE ?? "success"], options);
    const api = await import(${JSON.stringify(join(import.meta.dir, "platform.ts"))});
    const calls = () => existsSync("calls.jsonl") ? readFileSync("calls.jsonl", "utf8").trim().split("\\n").map(JSON.parse) : [];
    const leftovers = () => readdirSync(${JSON.stringify(nativeTemp)});
    const waitForCalls = async count => { while (calls().length < count) await Bun.sleep(10); };
    ${source}
  `);
  const child = Bun.spawn([process.execPath, fixture], {
    cwd: dir,
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: join(dir, "data"), RIKKAHUB_ANALYTICS: "0", TMPDIR: nativeTemp, LC_ALL: "C" },
    stdout: "pipe", stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Platform fixture failed (${code}): ${stderr}\n${stdout}`);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    clearTimeout(watchdog);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("macOS system clipboard", () => {
  test("round-trips Unicode, whitespace, shell-looking text and empty contents through UTF-8 stdin", async () => {
    const texts = ["\n  中文🙂 café e\u0301\nline two\r\n", "'\" $(touch never) `echo never` \\ --flag", ""];
    const result = await isolated(`
      const values = [];
      for (const text of ${JSON.stringify(texts)}) {
        await api.writeSystemClipboardText(text);
        values.push(await api.readSystemClipboardText());
      }
      console.log(JSON.stringify({ values, calls: calls(), backend: api.clipboardCommand() }));
    `);
    expect(result.values).toEqual(texts);
    expect(result.backend).toBe("mac");
    expect(result.calls.every((call: any) => call.locale === "en_US.UTF-8")).toBe(true);
    expect(result.calls.filter((_: any, index: number) => index % 2 === 0).map((call: any) => call.text)).toEqual(texts);
    expect(result.calls[0].command).toEqual(["/usr/bin/pbcopy"]);
    expect(result.calls[1].command).toEqual(["/usr/bin/pbpaste", "-Prefer", "txt"]);
  });

  test("read and write failures reject instead of reporting an empty clipboard or success", async () => {
    const result = await isolated(`
      process.env.FAKE_MODE = "fail";
      const errors = await Promise.all([api.writeSystemClipboardText("text"), api.readSystemClipboardText()].map(p => p.then(() => null, e => e.message)));
      console.log(JSON.stringify(errors));
    `);
    expect(result).toEqual(["native fixture failed", "native fixture failed"]);
  });

  test("server shutdown reaps a hanging clipboard child, while cancelling TTS leaves it alone", async () => {
    const result = await isolated(`
      const { shutdownOwnedProcesses } = await import(${JSON.stringify(join(import.meta.dir, "../foundation/owned-processes.ts"))});
      process.env.FAKE_MODE = "wait";
      const work = api.readSystemClipboardText().then(() => null, error => error.message);
      await waitForCalls(1);
      const pid = calls()[0].pid;
      api.cancelAllSystemTts();
      await Bun.sleep(40);
      let survivedTtsCancel = false; try { process.kill(pid, 0); survivedTtsCancel = true; } catch {}
      await shutdownOwnedProcesses({ deadline: Date.now() + 3000 });
      const error = await work;
      let gone = false; try { process.kill(pid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      const blocked = await api.readSystemClipboardText().then(() => null, error => error.message);
      console.log(JSON.stringify({ survivedTtsCancel, gone, error, blocked, starts: calls().length }));
    `);
    expect(result.survivedTtsCancel).toBe(true);
    expect(result.gone).toBe(true);
    expect(result.error).toContain("exited with code");
    expect(result.blocked).toContain("shutting down");
    expect(result.starts).toBe(1);
  });

  test("a hanging clipboard command hits its five-second deadline and is killed before rejection", async () => {
    const result = await isolated(`
      process.env.FAKE_MODE = "wait";
      const started = Date.now();
      const work = api.writeSystemClipboardText("fixture text").then(() => null, error => error.message);
      await waitForCalls(1);
      const pid = calls()[0].pid;
      const error = await work;
      let gone = false; try { process.kill(pid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      console.log(JSON.stringify({ error, gone, elapsed: Date.now() - started }));
    `);
    expect(result.error).toContain("Clipboard pbcopy exceeded deadline");
    expect(result.gone).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(4900);
    expect(result.elapsed).toBeLessThan(9000);
  }, 10_000);

  test("stdin failure stops the native clipboard process and observes its output", async () => {
    const result = await isolated(`
      const spawn = Bun.spawn.bind(Bun);
      let pid;
      Bun.spawn = (command, options) => {
        const child = spawn(command, options);
        pid = child.pid;
        return {
          pid: child.pid, exited: child.exited, stdout: child.stdout, stderr: child.stderr,
          get exitCode() { return child.exitCode; },
          kill: signal => child.kill(signal),
          stdin: { write() { throw new Error("stdin fixture failed"); }, end() { child.stdin.end(); } },
        };
      };
      const error = await api.writeSystemClipboardText("text").then(() => null, error => error.message);
      let gone = false; try { process.kill(pid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      console.log(JSON.stringify({ error, gone }));
    `);
    expect(result).toEqual({ error: "stdin fixture failed", gone: true });
  });

  test("retains the Windows PowerShell stdin interface", async () => {
    const result = await isolated(`
      await api.writeSystemClipboardText("中文\\n");
      const text = await api.readSystemClipboardText();
      console.log(JSON.stringify({ text, calls: calls() }));
    `, "win32");
    expect(result.text).toBe("中文\n");
    expect(result.calls.map((call: any) => call.command[0])).toEqual(["powershell.exe", "powershell.exe"]);
    expect(result.calls[0].command.at(-1)).toContain("[Console]::In.ReadToEnd()");
  });
});

describe("native system TTS", () => {
  test("macOS returns PCM WAV with stdin text, bounded rate and optional voice, then removes temporary output", async () => {
    const result = await isolated(`
      const audio = await api.synthesizeSystemTtsToWav("中文\\n'$(literal)'", 1.5, "Voice With Spaces");
      await api.synthesizeSystemTtsToWav("fast", 100);
      await api.synthesizeSystemTtsToWav("slow", 0.1);
      await api.synthesizeSystemTtsToWav("default", NaN);
      console.log(JSON.stringify({ audio: Array.from(audio), calls: calls(), leftovers: leftovers(), backend: api.systemTtsBackend() }));
    `);
    const audio = Buffer.from(result.audio);
    expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
    expect(audio.toString("ascii", 8, 12)).toBe("WAVE");
    expect(audio.readUInt16LE(20)).toBe(1);
    expect(audio.readUInt16LE(34)).toBe(16);
    expect(result.calls[0].text).toBe("中文\n'$(literal)'");
    expect(result.calls[0].command.slice(0, 7)).toEqual(["/usr/bin/say", "-f", "-", "-r", "263", "-v", "Voice With Spaces"]);
    expect(result.calls[0].command.slice(-2)).toEqual(["--file-format=WAVE", "--data-format=LEI16"]);
    expect(result.calls.slice(1).map((call: any) => call.command[4])).toEqual(["450", "80", "175"]);
    expect(result.calls[1].command).not.toContain("-v");
    expect(result.leftovers).toEqual([]);
    expect(result.backend).toBe("macos:say");
  });

  test.each(["fail", "invalid", "missing"])("cleans temporary files and releases the queue after %s synthesis", async (mode) => {
    const result = await isolated(`
      process.env.FAKE_MODE = ${JSON.stringify(mode)};
      const error = await api.synthesizeSystemTtsToWav("bad").then(() => null, e => e.message);
      const afterFailure = leftovers();
      process.env.FAKE_MODE = "success";
      const audio = await api.synthesizeSystemTtsToWav("retry");
      console.log(JSON.stringify({ error, afterFailure, bytes: audio.length, leftovers: leftovers() }));
    `);
    expect(result.error).toContain(mode === "fail" ? "exited 7" : mode === "invalid" ? "invalid WAV" : "failed to produce");
    expect(result.afterFailure).toEqual([]);
    expect(result.bytes).toBe(48);
    expect(result.leftovers).toEqual([]);
  });

  test("cancel awaits active native exit, invalidates queued speech, cleans partial WAV and permits new work", async () => {
    const result = await isolated(`
      process.env.FAKE_MODE = "wait";
      const work = Promise.allSettled([api.synthesizeSystemTtsToWav("one"), api.speakSystemText("two"), api.synthesizeSystemTtsToWav("three")]);
      await waitForCalls(1);
      const pid = calls()[0].pid;
      api.cancelAllSystemTts();
      const results = await work;
      let gone = false; try { process.kill(pid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      const count = calls().length;
      const afterCancel = leftovers();
      process.env.FAKE_MODE = "success";
      await api.synthesizeSystemTtsToWav("new work");
      console.log(JSON.stringify({ gone, count, errors: results.map(r => r.status === "rejected" ? r.reason.name : null), afterCancel, total: calls().length, leftovers: leftovers() }));
    `);
    expect(result).toEqual({ gone: true, count: 1, errors: ["AbortError", "AbortError", "AbortError"], afterCancel: [], total: 2, leftovers: [] });
  });

  test("Windows speech keeps its PowerShell backend and rate mapping", async () => {
    const result = await isolated(`
      await api.speakSystemText("Windows fixture", 1.5);
      console.log(JSON.stringify({ call: calls()[0], backend: api.systemTtsBackend() }));
    `, "win32");
    expect(result.call.command.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(result.call.command[4]).toContain("$s.Rate = 3");
    expect(result.call.text).toBe("Windows fixture");
    expect(result.backend).toBe("windows:System.Speech");
  });
});
