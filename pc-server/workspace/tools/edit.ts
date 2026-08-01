// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/edit.ts(v0.83.0)。schema/description/execute
// 逐字保留(edits[] 多处编辑、全部错误文案、legacy oldText/newText 参数修复、
// edits 字符串容错解析、BOM/换行往返);TUI 渲染与 diff 预览弃用(PC 由 M2 渲染器
// 从 details.diff 取)。schema 从 TypeBox 转写为等价 OpenAI JSON Schema(字段/描述原文)。

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveToCwd } from "./path-utils";
import type { WorkspaceToolDefinition } from "./types";

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

type LegacyEditToolInput = EditToolInput & {
  oldText?: unknown;
  newText?: unknown;
};

export interface EditToolDetails {
  /** Display-oriented diff of the changes made */
  diff: string;
  /** Standard unified patch of the changes made */
  patch: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * PC:边界校验层(M1-3)从这里注入。
 */
export interface EditOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    edits: {
      type: "array",
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          },
          newText: { type: "string", description: "Replacement text for this targeted edit." },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["path", "edits"],
} as const;

/** pi 原文:部分模型(Opus 4.6、GLM-5.1)把 edits 发成 JSON 字符串、或用 legacy
 *  顶层 oldText/newText——先修复参数形状再校验。 */
export function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = input as Record<string, unknown>;

  // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {}
  }

  const legacy = args as unknown as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as unknown as EditToolInput;
  }

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy;
  return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): WorkspaceToolDefinition<EditToolInput, EditToolDetails | undefined> {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: EDIT_SCHEMA as unknown as Record<string, unknown>,
    async execute(input, signal?) {
      const { path, edits } = validateEditInput(prepareEditArguments(input));
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort event listener here: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        // Checking signal.aborted after each await observes the same aborts while
        // keeping the queue locked until the current operation has settled.
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();

        // Check if file exists.
        try {
          await ops.access(absolutePath);
        } catch (error: unknown) {
          throwIfAborted();
          const errorMessage =
            error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
        }
        throwIfAborted();

        // Read the file.
        const buffer = await ops.readFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        throwIfAborted();

        // Strip BOM before matching. The model will not include an invisible BOM in oldText.
        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
        throwIfAborted();

        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await ops.writeFile(absolutePath, finalContent);
        throwIfAborted();

        const diffResult = generateDiffString(baseContent, newContent);
        const patch = generateUnifiedPatch(path, baseContent, newContent);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
            },
          ],
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
        };
      });
    },
  };
}
