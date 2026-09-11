// assets/fonts.ts — 字体清单与文件解析（内置/自定义/系统字体枚举、CSS 名称、文件定位）
// 纪律：纯搬迁自 server.ts（阶段 5.3b），行为不变。

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BuiltinManifest, FontEntry, FontWeightFile, ManifestEntry } from "../foundation/types";
import { customFontsDir, resourcePaths, resolveResourceFile, resolveResourceFiles } from "../foundation/paths";
import { readSystemFontFamilies } from "./system-fonts";

const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf", ".ttc"] as const;
export const FONT_EXTENSIONS_SET = new Set<string>(FONT_EXTENSIONS);
export const FONT_MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
};
const FONT_FORMAT: Record<string, string> = {
  ".woff2": "woff2",
  ".woff": "woff",
  ".ttf": "truetype",
  ".otf": "opentype",
  // .ttc(TrueType Collection)没有独立的 format 值,浏览器只认 truetype/opentype 等;
  // 写 "collection" 会让浏览器跳过整个 @font-face。用 truetype 取集合首个字形,是标准做法。
  ".ttc": "truetype",
};
// CJK 单文件可能十几 MB,留 50MB 余量足够;超过几乎一定是误传。
export const MAX_FONT_BYTES = 50 * 1024 * 1024;
const FONT_DEFAULT_FALLBACK = "system-ui, sans-serif";

export function fontExtension(name: string): string {
  return name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
}
export function isFontFile(name: string): boolean {
  return FONT_EXTENSIONS_SET.has(fontExtension(name));
}
// 纯文件名:无路径分隔符、无 NUL。用于拒绝 path traversal(../etc/passwd 之类)。
export function isBareFileName(name: string): boolean {
  return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
// @font-face family 名 = 文件名去扩展名。用全 stem(不去 -Regular 之类后缀)保证不撞名。
export function fontCssName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
function fontFormat(fileName: string): string | undefined {
  return FONT_FORMAT[fontExtension(fileName)];
}
// 显示名美化:"LXGWWenKai-Regular" → "LXGWWenKai"。去掉常见字重后缀,空格替分隔符。
function prettifyFontLabel(fileName: string): string {
  return fontCssName(fileName)
    .replace(/[-_](regular|normal|book|light|medium|semibold|demibold|bold|black|thin|extralight|extrabold)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || fontCssName(fileName);
}
// 从 CSS font-family 链中取出第一个族名(@font-face 用它做 font-family)。
// `"A B", serif` → `A B`;`Cursive, serif` → `Cursive`。
function firstFamilyName(family: string): string {
  const m = family.trim().match(/^"([^"]+)"|^'([^']+)'|^([^,]+)/);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? family.trim()).trim();
}
function readBuiltinFontManifest(): BuiltinManifest {
  for (const path of resolveResourceFiles("fonts", "manifest.json", true)) {
    try { return JSON.parse(readFileSync(path, "utf-8")) as BuiltinManifest; }
    catch (cause) {
      if (resourcePaths.explicit) throw new Error(`Invalid bundled font manifest: ${path}`, { cause });
      // 旧布局继续尝试下一既有目录；都不可用时允许自动派生。
    }
  }
  return {};
}

// 用 manifest 的 weights 定义构造一个字重族 entry。校验每个文件真实存在,过滤掉缺失的。
function makeWeightedFamilyEntry(source: "builtin" | "custom", manifestId: string, entry: ManifestEntry): FontEntry | null {
  const family = entry.family?.trim();
  if (!family || !Array.isArray(entry.weights) || entry.weights.length === 0) return null;
  const cssName = firstFamilyName(family);
  const weights: FontWeightFile[] = [];
  const seenFiles = new Set<string>();
  for (const w of entry.weights) {
    const fileName = w.file;
    if (!isBareFileName(fileName) || !isFontFile(fileName) || seenFiles.has(fileName.toLowerCase())) continue;
    seenFiles.add(fileName.toLowerCase());
    // 独立运行沿用缺失时跳过；显式包中清单声明的字体缺失则报告打包错误。
    const exists = resolveResourceFile("fonts", fileName, true) !== null;
    if (!exists) continue;
    weights.push({ fileName, weight: w.weight || 400, style: w.style === "italic" ? "italic" : "normal", format: fontFormat(fileName) });
  }
  if (weights.length === 0) return null;
  const label = entry.label?.trim() || cssName;
  return { id: `${source}:${manifestId}`, label, cssName, family, source, weights };
}

export function makeBundledFontEntry(source: "builtin" | "custom", fileName: string, override?: { label?: string; family?: string }): FontEntry {
  const cssName = override?.family?.trim() ? firstFamilyName(override.family) : fontCssName(fileName);
  const label = override?.label?.trim() || prettifyFontLabel(fileName);
  const family = override?.family?.trim() || `"${fontCssName(fileName)}", ${FONT_DEFAULT_FALLBACK}`;
  return {
    id: `${source}:${fileName}`,
    label,
    cssName,
    family,
    source,
    weights: [{ fileName, weight: 400, style: "normal", format: fontFormat(fileName) }],
  };
}

export function listBuiltinFonts(): FontEntry[] {
  const manifest = readBuiltinFontManifest();
  // 单文件 override 按文件名小写建索引；显式包中的清单条目必须随包存在。
  const manifestByLowerFile: Record<string, ManifestEntry> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (!v.weights) {
      if (isBareFileName(k) && isFontFile(k)) resolveResourceFile("fonts", k, true);
      manifestByLowerFile[k.toLowerCase()] = v;
    }
  }
  const out: FontEntry[] = [];
  const consumedFiles = new Set<string>();   // 已被某个 manifest 族消费的文件,跳过自动派生
  const seenAutoFiles = new Set<string>();

  // 1) 先处理 manifest 里带 weights 的字重族定义(HarmonyOS Sans 等)。
  for (const [manifestId, entry] of Object.entries(manifest)) {
    if (!entry.weights) continue;
    const built = makeWeightedFamilyEntry("builtin", manifestId, entry);
    if (built) {
      out.push(built);
      for (const w of built.weights) consumedFiles.add(w.fileName.toLowerCase());
    }
  }

  // 2) 扫描目录,对未被 manifest weights 消费的文件,自动派生(或读 manifest 单文件 override)。
  for (const dir of resourcePaths.fonts) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch (cause) {
      if (resourcePaths.explicit) throw new Error(`Bundled font directory is unavailable: ${dir}`, { cause });
      continue;
    }
    for (const name of entries) {
      if (!isFontFile(name)) continue;
      const key = name.toLowerCase();
      if (seenAutoFiles.has(key) || consumedFiles.has(key)) continue;
      seenAutoFiles.add(key);
      out.push(makeBundledFontEntry("builtin", name, manifestByLowerFile[key]));
    }
  }
  return out;
}

export function listCustomFonts(): FontEntry[] {
  try {
    mkdirSync(customFontsDir, { recursive: true });
    return readdirSync(customFontsDir)
      .filter(isFontFile)
      .map((name) => makeBundledFontEntry("custom", name));
  } catch {
    return [];
  }
}

// Native enumeration is asynchronous and cached; packaged macOS uses the shell's
// headless CoreText helper, while standalone/source execution uses system tools.
export async function listSystemFonts(excludeNames: Set<string>): Promise<FontEntry[]> {
  const names = await readSystemFontFamilies();
  return names.filter((name) => !excludeNames.has(name.toLowerCase())).map((name) => ({
    id: `system:${name}`, label: name, cssName: name,
    family: `${JSON.stringify(name)}, ${FONT_DEFAULT_FALLBACK}`,
    source: "system" as const, weights: [],
  }));
}

// 内置字体使用统一资源入口；自定义字体始终从用户数据目录读取。
export function resolveFontFile(source: "builtin" | "custom", fileName: string): string | null {
  if (!isBareFileName(fileName) || !isFontFile(fileName)) return null;
  if (source === "custom") {
    const p = join(customFontsDir, fileName);
    return existsSync(p) ? p : null;
  }
  return resolveResourceFile("fonts", fileName);
}
