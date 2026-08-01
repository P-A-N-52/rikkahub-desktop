// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/read.ts(v0.83.0)。schema/description/execute
// 逐字保留(offset/limit 语义、截断与续读提示文案、图片魔数嗅探);TUI 渲染弃用。
// PC 适配:
// - schema 从 TypeBox 转写为等价 OpenAI JSON Schema(字段/描述原文);
// - pi 的 processImage(2000x2000 自适应缩放)依赖 pi 自带图像栈,不移植——图片原样
//   base64 返回,超过 maxImageBytes(默认 10MB)报错引导模型换文本方式;
// - 非视觉模型提示由 options.modelSupportsImages 驱动(pi 从 ctx.model 取,PC 在
//   M1-4 接线时从 dispatch 上下文传入),提示文案原文。

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { detectSupportedImageMimeTypeFromFile } from "./mime";
import { resolveReadPathAsync } from "./path-utils";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate";
import type { ToolImageContent, ToolTextContent, WorkspaceToolDefinition } from "./types";

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 * PC:边界校验层(M1-3)从这里注入。
 */
export interface ReadOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type, return null or undefined for non-images */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ReadToolOptions {
  /** Custom operations for file reading. Default: local filesystem */
  operations?: ReadOperations;
  /** 当前模型是否支持图像输入(false 时附 pi 原文提示)。Default: true */
  modelSupportsImages?: boolean;
  /** 图片体积硬上限(PC 适配,替代 pi 的缩放管线)。Default: 10MB */
  maxImageBytes?: number;
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
} as const;

const NON_VISION_IMAGE_NOTE =
  "[Current model does not support images. The image will be omitted from this request.]";

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): WorkspaceToolDefinition<ReadToolInput, ReadToolDetails | undefined> {
  const ops = options?.operations ?? defaultReadOperations;
  const modelSupportsImages = options?.modelSupportsImages ?? true;
  const maxImageBytes = options?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  return {
    name: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: READ_SCHEMA as unknown as Record<string, unknown>,
    async execute({ path, offset, limit }, signal?) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      const absolutePath = await resolveReadPathAsync(path, cwd);
      throwIfAborted();
      // Check if file exists and is readable.
      await ops.access(absolutePath);
      throwIfAborted();
      const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
      throwIfAborted();
      let content: (ToolTextContent | ToolImageContent)[];
      let details: ReadToolDetails | undefined;
      const nonVisionImageNote = modelSupportsImages ? undefined : NON_VISION_IMAGE_NOTE;
      if (mimeType) {
        // Read image as binary.
        const buffer = await ops.readFile(absolutePath);
        throwIfAborted();
        if (buffer.length > maxImageBytes) {
          // PC 适配:无缩放管线,超限直接报错(pi 会缩放到 2000x2000)
          let textNote = `Read image file [${mimeType}]\nImage is ${formatSize(buffer.length)}, exceeds ${formatSize(maxImageBytes)} limit and cannot be attached.`;
          if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
          content = [{ type: "text", text: textNote }];
        } else {
          let textNote = `Read image file [${mimeType}]`;
          if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
          content = [
            { type: "text", text: textNote },
            { type: "image", data: buffer.toString("base64"), mimeType },
          ];
        }
      } else {
        // Read text content.
        const buffer = await ops.readFile(absolutePath);
        throwIfAborted();
        const textContent = buffer.toString("utf-8");
        const allLines = textContent.split("\n");
        const totalFileLines = allLines.length;
        // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
        const startLine = offset ? Math.max(0, offset - 1) : 0;
        const startLineDisplay = startLine + 1;
        // Check if offset is out of bounds.
        if (startLine >= allLines.length) {
          throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
        }
        let selectedContent: string;
        let userLimitedLines: number | undefined;
        // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
        if (limit !== undefined) {
          const endLine = Math.min(startLine + limit, allLines.length);
          selectedContent = allLines.slice(startLine, endLine).join("\n");
          userLimitedLines = endLine - startLine;
        } else {
          selectedContent = allLines.slice(startLine).join("\n");
        }
        // Apply truncation, respecting both line and byte limits.
        const truncation = truncateHead(selectedContent);
        let outputText: string;
        if (truncation.firstLineExceedsLimit) {
          // First line alone exceeds the byte limit. Point the model at a bash fallback.
          const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
          outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
          details = { truncation };
        } else if (truncation.truncated) {
          // Truncation occurred. Build an actionable continuation notice.
          const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
          const nextOffset = endLineDisplay + 1;
          outputText = truncation.content;
          if (truncation.truncatedBy === "lines") {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
          } else {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
          }
          details = { truncation };
        } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
          // User-specified limit stopped early, but the file still has more content.
          const remaining = allLines.length - (startLine + userLimitedLines);
          const nextOffset = startLine + userLimitedLines + 1;
          outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
        } else {
          // No truncation and no remaining user-limited content.
          outputText = truncation.content;
        }
        content = [{ type: "text", text: outputText }];
      }

      throwIfAborted();
      return { content, details };
    },
  };
}
