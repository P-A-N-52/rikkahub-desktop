// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/ls.ts(v0.83.0)。schema/description/execute
// 逐字保留(排序、目录尾 /、条目上限与截断提示文案);TUI 渲染弃用,TypeBox → OpenAI JSON Schema。
// 挂载策略(2026-08-01):仅在 bash 不可用时作为兜底挂载(pi 默认也不挂,bash 在手时
// ls 职责由 bash 承担,避免稀释工具面)。

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import { pathExists, resolveToCwd } from "./path-utils";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

export interface LsToolInput {
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * PC:边界校验层从这里注入。
 */
export interface LsOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Get file or directory stats. Throws if not found. */
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries */
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: fsStat,
  readdir: (path) => fsReaddir(path),
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
}

// 与 pi 原版逐字一致:无必填参数时不写 required 键(TypeBox 同样省略;
// P3 契约对照测试按语义全等钉住,required:[] 与缺省虽等价,但移植逐字纪律优先)。
const LS_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list (default: current directory)" },
    limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
  },
} as const;

export function createLsTool(
  cwd: string,
  options?: LsToolOptions,
): WorkspaceToolDefinition<LsToolInput, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  return {
    name: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: LS_SCHEMA as unknown as Record<string, unknown>,
    async execute({ path, limit }, signal?) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();

      const dirPath = resolveToCwd(path || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      if (!(await ops.exists(dirPath))) {
        throw new Error(`Path not found: ${dirPath}`);
      }
      const stat = await ops.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      let entries: string[];
      try {
        entries = [...(await ops.readdir(dirPath))];
      } catch (e: any) {
        throw new Error(`Cannot read directory: ${e.message}`);
      }
      throwIfAborted();

      // Sort alphabetically, case-insensitive.
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Format entries with directory indicators.
      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        const fullPath = nodePath.join(dirPath, entry);
        let suffix = "";
        try {
          const entryStat = await ops.stat(fullPath);
          if (entryStat.isDirectory()) suffix = "/";
        } catch {
          // Skip entries we cannot stat.
          continue;
        }
        results.push(entry + suffix);
      }
      throwIfAborted();

      if (results.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
      }

      const rawOutput = results.join("\n");
      // Apply byte truncation. There is no separate line limit because entry count is already capped.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: LsToolDetails = {};
      // Build actionable notices for truncation and entry limits.
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
