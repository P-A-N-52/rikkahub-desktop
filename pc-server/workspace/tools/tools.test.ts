// workspace/tools/tools.test.ts — pi 移植层回归(M1-2)
// 目标不是重测 pi(上游自有测试),而是验证移植后行为完好:schema/文案锚点、
// edit 的 BOM/CRLF 往返与错误文案、read 的截断续读提示、write 回执、
// mutation queue 串行化、truncate 边界、bash 冒烟(本机有 bash 才跑)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool } from "./bash";
import { createEditTool, prepareEditArguments } from "./edit";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";
import { withFileMutationQueue } from "./file-mutation-queue";
import { getShellConfig } from "./shell";
import { truncateHead, truncateTail } from "./truncate";
import type { ToolTextContent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "rkh-pi-tools-"));

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((c) => c.type === "text") as ToolTextContent[]).map((c) => c.text).join("\n");
}

describe("read(pi 语义)", () => {
  test("offset/limit 与续读提示文案", async () => {
    const file = join(dir, "read-target.txt");
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n"));
    const tool = createReadTool(dir);
    const result = await tool.execute({ path: "read-target.txt", offset: 10, limit: 5 });
    const text = textOf(result);
    expect(text).toContain("line-10");
    expect(text).toContain("line-14");
    expect(text).toContain("[86 more lines in file. Use offset=15 to continue.]");
  });

  test("offset 越界报 pi 原文错误", async () => {
    const file = join(dir, "read-short.txt");
    writeFileSync(file, "only\n");
    const tool = createReadTool(dir);
    await expect(tool.execute({ path: "read-short.txt", offset: 99 })).rejects.toThrow("beyond end of file");
  });

  test("超限文件截断并给续读 offset", async () => {
    const file = join(dir, "read-big.txt");
    writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n"));
    const tool = createReadTool(dir);
    const result = await tool.execute({ path: "read-big.txt" });
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(textOf(result)).toContain("Use offset=2001 to continue.");
  });
});

describe("write(pi 语义)", () => {
  test("自动建父目录 + 字节数回执", async () => {
    const tool = createWriteTool(dir);
    const result = await tool.execute({ path: "nested/deep/new.txt", content: "hello" });
    expect(textOf(result)).toBe("Successfully wrote 5 bytes to nested/deep/new.txt");
    expect(readFileSync(join(dir, "nested/deep/new.txt"), "utf-8")).toBe("hello");
  });
});

describe("edit(pi 语义)", () => {
  test("多处编辑 + BOM/CRLF 往返保持", async () => {
    const file = join(dir, "edit-crlf.txt");
    writeFileSync(file, "﻿alpha\r\nbeta\r\ngamma\r\n");
    const tool = createEditTool(dir);
    const result = await tool.execute({
      path: "edit-crlf.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
    });
    expect(textOf(result)).toBe("Successfully replaced 2 block(s) in edit-crlf.txt.");
    expect(result.details?.diff).toContain("+");
    expect(result.details?.patch).toContain("@@");
    // BOM 与 CRLF 都要原样保留
    expect(readFileSync(file, "utf-8")).toBe("﻿ALPHA\r\nbeta\r\nGAMMA\r\n");
  });

  test("找不到/多处出现/重叠的 pi 原文错误文案", async () => {
    const file = join(dir, "edit-errors.txt");
    writeFileSync(file, "dup\ndup\nunique\n");
    const tool = createEditTool(dir);
    await expect(tool.execute({ path: "edit-errors.txt", edits: [{ oldText: "missing", newText: "x" }] }))
      .rejects.toThrow("Could not find the exact text");
    await expect(tool.execute({ path: "edit-errors.txt", edits: [{ oldText: "dup", newText: "x" }] }))
      .rejects.toThrow("The text must be unique");
    await expect(tool.execute({
      path: "edit-errors.txt",
      edits: [
        { oldText: "dup\ndup\nunique", newText: "a" },
        { oldText: "unique", newText: "b" },
      ],
    })).rejects.toThrow(/overlap|unique/);
  });

  test("fuzzy 匹配:智能引号归一后命中", async () => {
    const file = join(dir, "edit-fuzzy.txt");
    writeFileSync(file, "it’s a smart quote\nplain line\n");
    const tool = createEditTool(dir);
    const result = await tool.execute({
      path: "edit-fuzzy.txt",
      edits: [{ oldText: "it's a smart quote", newText: "fixed" }],
    });
    expect(textOf(result)).toContain("Successfully replaced 1 block(s)");
    expect(readFileSync(file, "utf-8")).toContain("fixed");
  });

  test("legacy oldText/newText 与 edits 字符串参数修复", () => {
    const fromLegacy = prepareEditArguments({ path: "a.txt", oldText: "x", newText: "y" });
    expect(fromLegacy.edits).toEqual([{ oldText: "x", newText: "y" }]);
    const fromString = prepareEditArguments({ path: "a.txt", edits: '[{"oldText":"x","newText":"y"}]' });
    expect(fromString.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });
});

describe("file-mutation-queue", () => {
  test("同文件串行、异文件并行", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = withFileMutationQueue(join(dir, "queue-a.txt"), async () => {
      order.push("a1-start");
      await gate.promise;
      order.push("a1-end");
    });
    const second = withFileMutationQueue(join(dir, "queue-a.txt"), async () => {
      order.push("a2");
    });
    const other = withFileMutationQueue(join(dir, "queue-b.txt"), async () => {
      order.push("b");
    });
    await other;
    expect(order).toContain("b");
    expect(order).not.toContain("a2"); // 同文件第二个必须等第一个
    gate.resolve();
    await Promise.all([first, second]);
    expect(order.indexOf("a1-end")).toBeLessThan(order.indexOf("a2"));
  });
});

describe("truncate", () => {
  test("head/tail 行数与字节双限", () => {
    const content = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const head = truncateHead(content, { maxLines: 3 });
    expect(head.truncated).toBe(true);
    expect(head.content).toBe("l0\nl1\nl2");
    const tail = truncateTail(content, { maxLines: 2 });
    expect(tail.content).toBe("l8\nl9");
    const byBytes = truncateHead("x".repeat(100), { maxBytes: 10 });
    expect(byBytes.firstLineExceedsLimit).toBe(true);
  });
});

describe("bash(冒烟,本机有 bash 才跑)", () => {
  let hasBash = true;
  try { getShellConfig(); } catch { hasBash = false; }

  test.if(hasBash)("echo 往返 + exitCode 结构化", async () => {
    const tool = createBashTool(dir);
    const result = await tool.execute({ command: "echo workspace-smoke" });
    expect(textOf(result)).toContain("workspace-smoke");
    expect(result.details?.exitCode).toBe(0);
  });

  test.if(hasBash)("非零退出码走 pi 报错文案", async () => {
    const tool = createBashTool(dir);
    await expect(tool.execute({ command: "exit 7" })).rejects.toThrow("Command exited with code 7");
  });

  test.if(hasBash)("abort 杀进程树", async () => {
    const tool = createBashTool(dir);
    const controller = new AbortController();
    const pending = tool.execute({ command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow("Command aborted");
  }, 10_000);
});
