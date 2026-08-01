// workspace/boundary.test.ts — 边界校验与限额单测(M1-3)
// §5.3 要求全覆盖:../ 穿越、绝对路径、符号链接逃逸、Windows 盘符兄弟目录、
// 不存在尾段(write 新文件)、限额闸门(读 512KB/写 2MB)、经工具全链路的越界拒绝。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";

import {
  assertInsideWorkspace,
  createBoundedEditOperations,
  createBoundedReadOperations,
  createBoundedWriteOperations,
  READ_HARD_LIMIT_BYTES,
  WorkspaceBoundaryError,
  WRITE_HARD_LIMIT_BYTES,
} from "./boundary";
import { createReadTool } from "./tools/read";
import { createWriteTool } from "./tools/write";
import { createEditTool } from "./tools/edit";

const host = mkdtempSync(join(tmpdir(), "rkh-boundary-"));
const root = join(host, "ws");
const outside = join(host, "outside");
mkdirSync(root, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "inside.txt"), "inside content");
writeFileSync(join(outside, "secret.txt"), "secret");

/** Windows 无特权环境软链可能被拒(需开发者模式);拿到能力再跑软链用例。 */
function canSymlink(): boolean {
  try {
    const probe = join(host, `probe-${Date.now()}`);
    symlinkSync(outside, probe, "junction");
    return true;
  } catch {
    return false;
  }
}
const symlinkOk = canSymlink();

describe("assertInsideWorkspace", () => {
  test("区内路径放行并 realpath 化;root 自身放行", () => {
    expect(assertInsideWorkspace(join(root, "inside.txt"), root)).toContain("inside.txt");
    expect(() => assertInsideWorkspace(root, root)).not.toThrow();
  });

  test("../ 穿越拒绝", () => {
    expect(() => assertInsideWorkspace(resolve(root, "..", "outside", "secret.txt"), root))
      .toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(resolve(root, "sub", "..", "..", "escape.txt"), root))
      .toThrow(WorkspaceBoundaryError);
  });

  test("区外绝对路径拒绝(含系统根)", () => {
    expect(() => assertInsideWorkspace(join(outside, "secret.txt"), root)).toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(parse(root).root, root)).toThrow(WorkspaceBoundaryError);
  });

  test("盘符/前缀兄弟目录拒绝(前缀必须带分隔符)", () => {
    const sibling = `${root}2`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "x.txt"), "x");
    expect(() => assertInsideWorkspace(join(sibling, "x.txt"), root)).toThrow(WorkspaceBoundaryError);
  });

  test("不存在的尾段(write 新文件/新目录)按最深存在祖先判界", () => {
    expect(() => assertInsideWorkspace(join(root, "new-dir", "new-file.txt"), root)).not.toThrow();
    expect(() => assertInsideWorkspace(join(outside, "new-dir", "new-file.txt"), root)).toThrow(WorkspaceBoundaryError);
  });

  test.if(symlinkOk)("软链逃逸拒绝:链本体在区内、目标在区外", () => {
    const link = join(root, "escape-link");
    symlinkSync(outside, link, "junction");
    expect(() => assertInsideWorkspace(join(link, "secret.txt"), root)).toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(link, root)).toThrow(WorkspaceBoundaryError);
  });

  test("NUL 字节路径拒绝", () => {
    expect(() => assertInsideWorkspace(join(root, "a\0b"), root)).toThrow(WorkspaceBoundaryError);
  });

  test("Windows 大小写不敏感:大小写变体不误伤", () => {
    if (process.platform !== "win32") return;
    const upper = join(root.toUpperCase(), "inside.txt");
    expect(() => assertInsideWorkspace(upper, root)).not.toThrow();
  });
});

describe("限额闸门", () => {
  test("读 512KB:超限文件报错并引导 bash 分段", async () => {
    const big = join(root, "big.txt");
    writeFileSync(big, Buffer.alloc(READ_HARD_LIMIT_BYTES + 1, 0x61));
    const ops = createBoundedReadOperations(root);
    await expect(ops.readFile(big)).rejects.toThrow("read limit");
    // 未超限正常读
    const ok = await ops.readFile(join(root, "inside.txt"));
    expect(ok.toString()).toBe("inside content");
  });

  test("写 2MB:超限内容报错", async () => {
    const ops = createBoundedWriteOperations(root);
    await expect(ops.writeFile(join(root, "big-write.txt"), "x".repeat(WRITE_HARD_LIMIT_BYTES + 1)))
      .rejects.toThrow("write limit");
  });
});

describe("工具全链路(内核 pi 原样 + 有界 Operations)", () => {
  test("read:相对路径 ../ 逃逸被拒;区内正常", async () => {
    const tool = createReadTool(root, { operations: createBoundedReadOperations(root) });
    await expect(tool.execute({ path: "../outside/secret.txt" })).rejects.toThrow("Access denied");
    const ok = await tool.execute({ path: "inside.txt" });
    expect(ok.content[0]).toEqual({ type: "text", text: "inside content" });
  });

  test("read:~ 展开指向家目录也被拒(家目录在区外)", async () => {
    const tool = createReadTool(root, { operations: createBoundedReadOperations(root) });
    await expect(tool.execute({ path: "~/anything.txt" })).rejects.toThrow("Access denied");
  });

  test("write:区外绝对路径被拒,mkdir 不落地", async () => {
    const tool = createWriteTool(root, { operations: createBoundedWriteOperations(root) });
    await expect(tool.execute({ path: join(outside, "evil/pwn.txt"), content: "x" })).rejects.toThrow("Access denied");
    const ok = await tool.execute({ path: "sub/ok.txt", content: "fine" });
    expect(ok.content[0].type).toBe("text");
  });

  test("edit:区外文件被拒", async () => {
    const tool = createEditTool(root, { operations: createBoundedEditOperations(root) });
    await expect(tool.execute({ path: join(outside, "secret.txt"), edits: [{ oldText: "secret", newText: "x" }] }))
      .rejects.toThrow(/Access denied|Could not edit/);
  });
});
