// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/write.ts(v0.83.0)。schema/description/execute
// 逐字保留(mkdir 自动建父目录、字节数回执、mutation queue 内查 abort 的不变量);
// TUI 渲染弃用。schema 从 TypeBox 转写为等价 OpenAI JSON Schema(字段/描述原文)。

import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveToCwd } from "./path-utils";
import type { WorkspaceToolDefinition } from "./types";

export interface WriteToolInput {
  path: string;
  content: string;
}

/**
 * Pluggable operations for the write tool.
 * PC:边界校验层(M1-3)从这里注入。
 */
export interface WriteOperations {
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Create directory recursively */
  mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
  /** Custom operations for file writing. Default: local filesystem */
  operations?: WriteOperations;
}

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to write (relative or absolute)" },
    content: { type: "string", description: "Content to write to the file" },
  },
  required: ["path", "content"],
} as const;

export function createWriteTool(
  cwd: string,
  options?: WriteToolOptions,
): WorkspaceToolDefinition<WriteToolInput, undefined> {
  const ops = options?.operations ?? defaultWriteOperations;
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: WRITE_SCHEMA as unknown as Record<string, unknown>,
    async execute({ path, content }, signal?) {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);
      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort event listener here: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        // Checking signal.aborted after each await observes the same aborts while
        // keeping the queue locked until the current operation has settled.
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();
        // Create parent directories if needed.
        await ops.mkdir(dir);
        throwIfAborted();

        // Write the file contents.
        await ops.writeFile(absolutePath, content);
        throwIfAborted();

        return {
          content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }],
          details: undefined,
        };
      });
    },
  };
}
