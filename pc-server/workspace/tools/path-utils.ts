// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/path-utils.ts + src/utils/paths.ts 中被工具层
// 引用的子集(v0.83.0)。逻辑逐字保留;删去 pi CLI 私有函数(@file 前缀之外的 npm:/git:
// 判别、云同步 xattr 等)。macOS 文件名变体兜底(NFD/弯引号/窄空格)对 Win/Linux 无害
// (变体不命中时原样返回),按"照原文搬"保留。
// 注意:pi 的 resolveToCwd 没有任何边界校验(pi 信任 cwd)——PC 的工作区边界层包裹在
// Operations 注入点上(boundary.ts,M1-3),本文件保持 pi 原语义。

import { accessSync, constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/g;
const NARROW_NO_BREAK_SPACE = " ";

export interface PathInputOptions {
  /** Trim leading/trailing whitespace before normalization. */
  trim?: boolean;
  /** Expand leading `~` to a home directory. Defaults to true. */
  expandTilde?: boolean;
  /** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Strip a leading `@`, used for CLI @file paths. */
  stripAtPrefix?: boolean;
  /** Normalize unicode space variants to regular spaces. */
  normalizeUnicodeSpaces?: boolean;
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }

  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      return join(home, normalized.slice(2));
    }
  }

  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  // macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  // macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
  // Users typically type U+0027 (straight apostrophe)
  return filePath.replace(/'/g, "’");
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);

  if (fileExists(resolved)) {
    return resolved;
  }

  // Try macOS AM/PM variant (narrow no-break space before AM/PM)
  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) {
    return amPmVariant;
  }

  // Try NFD variant (macOS stores filenames in NFD form)
  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && fileExists(nfdVariant)) {
    return nfdVariant;
  }

  // Try curly quote variant (macOS uses U+2019 in screenshot names)
  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) {
    return curlyVariant;
  }

  // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
    return nfdCurlyVariant;
  }

  return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);

  if (await pathExists(resolved)) {
    return resolved;
  }

  // Try macOS AM/PM variant (narrow no-break space before AM/PM)
  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
    return amPmVariant;
  }

  // Try NFD variant (macOS stores filenames in NFD form)
  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
    return nfdVariant;
  }

  // Try curly quote variant (macOS uses U+2019 in screenshot names)
  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
    return curlyVariant;
  }

  // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
    return nfdCurlyVariant;
  }

  return resolved;
}
