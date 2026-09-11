// tools/platform.ts — 本地工具调用的平台能力（剪贴板、系统 TTS）
// 纪律：只封装 OS 命令调用，不依赖业务状态。

import { existsSync, rmSync, readFileSync } from "node:fs";
import { bumpAnalyticsTtsCount } from "../app-config/analytics";
import { join } from "node:path";
import { tempDir } from "../foundation/platform";
import { assertProcessSpawningAllowed, trackOwnedBunProcess, stopBunProcess, waitUntil, type ProcessShutdownOptions } from "../foundation/owned-processes";

export async function runPowerShell(command: string, input = "") {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    proc.stdin.write(input);
  }
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${exitCode}`);
  return stdout;
}

export function clipboardCommand(): string | null {
  if (process.platform === "darwin") return "mac";
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
    return "wl";
  }
  if (process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "x11") {
    return "x11";
  }
  return null;
}

async function runMacClipboard(command: "pbcopy" | "pbpaste", input = ""): Promise<string> {
  assertProcessSpawningAllowed();
  const deadline = Date.now() + 5_000;
  const child = Bun.spawn([`/usr/bin/${command}`, ...(command === "pbpaste" ? ["-Prefer", "txt"] : [])], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    // Finder does not inherit Terminal's UTF-8 locale.
    env: { ...process.env, LC_ALL: "en_US.UTF-8" },
  });
  trackOwnedBunProcess(child);
  const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    child.stdin.write(input);
    child.stdin.end();
    const [code, stdout, stderr] = await waitUntil(output, { deadline }, `Clipboard ${command}`);
    if (code !== 0) throw new Error(stderr.trim() || `${command} exited with code ${code}`);
    return stdout;
  } catch (error) {
    // A stdin failure can happen before output is awaited; keep its rejection observed.
    void output.catch(() => undefined);
    await stopBunProcess(child, { deadline: Date.now() + 1_000 });
    throw error;
  }
}

export async function readSystemClipboardText() {
  if (process.platform === "win32") {
    return runPowerShell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw");
  }
  const backend = clipboardCommand();
  if (backend === "mac") return runMacClipboard("pbpaste");
  try {
    if (backend === "wl") {
      const proc = Bun.spawnSync(["wl-paste"]);
      if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim();
    } else if (backend === "x11") {
      const proc = Bun.spawnSync(["xclip", "-selection", "clipboard", "-o"]);
      if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim();
    }
  } catch (e) { console.warn("[clipboard] read failed:", e); }
  return "";
}

export async function writeSystemClipboardText(text: string) {
  if (process.platform === "win32") {
    await runPowerShell("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);
    return;
  }
  const backend = clipboardCommand();
  if (backend === "mac") {
    await runMacClipboard("pbcopy", text);
    return;
  }
  try {
    if (backend === "wl") {
      const proc = Bun.spawn(["wl-copy"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
    } else if (backend === "x11") {
      const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
    }
  } catch (e) { console.warn("[clipboard] write failed:", e); }
}

// Queue cancellation has an epoch: tasks already queued must never start after cancel.
let systemTtsChain: Promise<void> = Promise.resolve();
let systemTtsEpoch = 0;
let systemTtsStopping = false;
let systemTtsShutdown: Promise<void> | undefined;
const activeSystemTtsProcs = new Set<Bun.Subprocess>();

async function serializeSystemTts<T>(run: () => Promise<T>): Promise<T> {
  if (systemTtsStopping) throw new DOMException("System TTS is shutting down", "AbortError");
  const epoch = systemTtsEpoch;
  const previous = systemTtsChain;
  let release!: () => void;
  systemTtsChain = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous;
    if (systemTtsStopping || epoch !== systemTtsEpoch) throw new DOMException("System TTS cancelled", "AbortError");
    const result = await run();
    if (systemTtsStopping || epoch !== systemTtsEpoch) throw new DOMException("System TTS cancelled", "AbortError");
    return result;
  } catch (error) {
    if (systemTtsStopping || epoch !== systemTtsEpoch) throw new DOMException("System TTS cancelled", "AbortError");
    throw error;
  } finally {
    release();
  }
}

export function systemTtsBackend(): string {
  if (process.platform === "win32") return "windows:System.Speech";
  return process.platform === "darwin" ? "macos:say" : "linux:espeak-ng";
}

async function runSystemTts(text: string, speechRate: number, output?: string, voice?: string): Promise<void> {
  let command: string[];
  const normalizedRate = Number.isFinite(speechRate) && speechRate > 0 ? speechRate : 1;
  if (process.platform === "win32") {
    const rate = Math.max(-10, Math.min(10, Math.round((normalizedRate - 1) * 5)));
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.Rate = ${rate}`,
      ...(output ? [`$s.SetOutputToWaveFile('${output.replace(/'/g, "''")}')`] : []),
      "$s.Speak([Console]::In.ReadToEnd())",
      "$s.Dispose()",
    ].join("; ");
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
  } else {
    const speed = Math.max(80, Math.min(450, Math.round(175 * normalizedRate)));
    command = process.platform === "darwin"
      ? ["/usr/bin/say", "-f", "-", "-r", String(speed), ...(voice?.trim() ? ["-v", voice.trim()] : []),
        ...(output ? ["-o", output, "--file-format=WAVE", "--data-format=LEI16"] : [])]
      : ["espeak-ng", ...(output ? ["-w", output] : []), "--stdin", "-s", String(speed)];
  }
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  activeSystemTtsProcs.add(child);
  // Drain stderr during synthesis so its pipe cannot block a verbose child.
  const stderr = new Response(child.stderr).text();
  try {
    child.stdin.write(text);
    child.stdin.end();
    const exitCode = await child.exited;
    const message = await stderr;
    if (exitCode !== 0) throw new Error(`System TTS exited ${exitCode}${message.trim() ? `: ${message.trim().slice(0, 200)}` : ""}`);
  } catch (error) {
    // A failed stdin write must not let the queue start another native speaker.
    await stopBunProcess(child, { deadline: Date.now() + 3_000 });
    throw error;
  } finally {
    // Keep the handle until exit even if writing input fails.
    void child.exited.then(() => activeSystemTtsProcs.delete(child), () => activeSystemTtsProcs.delete(child));
    void stderr.catch(() => {});
  }
}

export async function speakSystemText(text: string, speechRate = 1, voice?: string) {
  bumpAnalyticsTtsCount();
  await serializeSystemTts(() => runSystemTts(text, speechRate, undefined, voice));
}

export async function synthesizeSystemTtsToWav(text: string, speechRate = 1, voice?: string): Promise<Buffer> {
  return serializeSystemTts(async () => {
    const tmpWav = join(tempDir(), `rikka-tts-${crypto.randomUUID()}.wav`);
    try {
      await runSystemTts(text, speechRate, tmpWav, voice);
      if (!existsSync(tmpWav)) throw new Error("System TTS failed to produce audio file");
      const audio = readFileSync(tmpWav);
      if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("System TTS produced invalid WAV audio");
      }
      return audio;
    } finally {
      rmSync(tmpWav, { force: true });
    }
  });
}

/** Existing cancel endpoint is synchronous, but cancelled queued work is invalidated too. */
export function cancelAllSystemTts(): void {
  systemTtsEpoch += 1;
  for (const child of activeSystemTtsProcs) {
    void stopBunProcess(child, { deadline: Date.now() + 3_000 }).catch((error) => {
      console.warn("[tts] System TTS cancellation failed:", error);
    });
  }
}

export function shutdownSystemTts(options: ProcessShutdownOptions): Promise<void> {
  systemTtsStopping = true;
  systemTtsEpoch += 1;
  return systemTtsShutdown ??= (async () => {
    const results = await Promise.allSettled([
      ...[...activeSystemTtsProcs].map((child) => stopBunProcess(child, options)),
      waitUntil(systemTtsChain, options, "System TTS queue"),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "System TTS did not stop cleanly");
  })();
}
