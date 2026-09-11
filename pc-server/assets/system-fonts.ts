import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertProcessSpawningAllowed, trackOwnedProcess } from "../foundation/owned-processes";

type FontFormat = "families" | "profiler" | "lines" | "fontconfig";
interface FontCommand { executable: string; args: string[]; format: FontFormat; }

export function systemFontCommand(platform: string, helper?: string): FontCommand | null {
  if (platform === "darwin") {
    if (helper !== undefined) {
      if (!isAbsolute(helper)) throw new Error("RIKKAHUB_FONT_HELPER must be an absolute executable path");
      return { executable: helper, args: ["--list-system-fonts"], format: "families" };
    }
    return { executable: "/usr/sbin/system_profiler", args: ["SPFontsDataType", "-json", "-detailLevel", "mini"], format: "profiler" };
  }
  if (platform === "win32") return {
    executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"],
    format: "lines",
  };
  if (platform === "linux") return { executable: "fc-list", args: [":", "family"], format: "fontconfig" };
  return null;
}

function normalizeNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && !name.startsWith(".") && !/[\u0000-\u001f\u007f]/.test(name)))]
    .sort((left, right) => left.localeCompare(right));
}

export function parseFontFamilies(output: string, format: FontFormat): string[] {
  if (format === "families") {
    const names: unknown = JSON.parse(output);
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new Error("Native font helper returned an invalid family list");
    return normalizeNames(names);
  }
  if (format === "profiler") {
    const report = JSON.parse(output) as { SPFontsDataType?: Array<{ enabled?: string; valid?: string; typefaces?: Array<{ enabled?: string; valid?: string; family?: string }> }> };
    if (!Array.isArray(report.SPFontsDataType)) throw new Error("System font report is missing SPFontsDataType");
    return normalizeNames(report.SPFontsDataType.flatMap((file) => {
      if (file.enabled !== "yes" || file.valid !== "yes" || !Array.isArray(file.typefaces)) return [];
      return file.typefaces.filter((face) => face.enabled === "yes" && face.valid === "yes" && typeof face.family === "string").map((face) => face.family!);
    }));
  }
  const lines = output.split(/\r?\n/);
  return normalizeNames(format === "fontconfig" ? lines.flatMap((line) => line.split(",")).filter((name) => !name.includes(":")) : lines);
}

async function run(command: FontCommand, timeoutMs: number): Promise<string> {
  assertProcessSpawningAllowed();
  const child = spawn(command.executable, command.args, {
    stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true,
  });
  const owned = trackOwnedProcess(child);
  let failure: Error | undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => {
    failure = new Error(`System font query exceeded ${timeoutMs} ms`);
    owned.kill();
  }, timeoutMs);
  try {
    return await new Promise<string>((resolve, reject) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          failure ??= new Error("System font report exceeded the output limit");
          owned.kill();
        } else chunks.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`System font query exited with ${signal ?? code}`));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function querySystemFontFamilies(platform = process.platform, helper = process.env.RIKKAHUB_FONT_HELPER, timeoutMs = 15_000): Promise<string[]> {
  const command = systemFontCommand(platform, helper);
  return command ? parseFontFamilies(await run(command, timeoutMs), command.format) : [];
}

/** One query in flight and one successful result per backend lifetime. */
export function cacheFontFamilies(load: () => Promise<string[]>): () => Promise<string[]> {
  let pending: Promise<string[]> | undefined;
  return () => pending ??= load().catch((error) => { pending = undefined; throw error; });
}

export const readSystemFontFamilies = cacheFontFamilies(() => querySystemFontFamilies());
