// workspace/files.test.ts — 文件面板领域操作单测（M3-5）。reveal 不测（起系统进程）。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../foundation/types";
import { WorkspaceBoundaryError } from "./boundary";
import { deleteWorkspaceEntry, listWorkspaceDir, previewWorkspaceFile, renameWorkspaceEntry } from "./files";

const host = mkdtempSync(join(tmpdir(), "rkh-files-"));
const root = join(host, "ws");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "readme.md"), "# hello");
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 0, 3]));
writeFileSync(join(host, "outside.txt"), "secret");

const workspace = { id: "w1", root } as Workspace;

describe("listWorkspaceDir", () => {
  test("目录优先、名称排序,带类型与体积", () => {
    const entries = listWorkspaceDir(workspace, "");
    expect(entries.map((e) => e.name)).toEqual(["src", "bin.dat", "readme.md"]);
    expect(entries[0]!.type).toBe("dir");
    expect(entries.find((e) => e.name === "readme.md")!.size).toBeGreaterThan(0);
  });

  test("越界路径拒绝", () => {
    expect(() => listWorkspaceDir(workspace, "..")).toThrow(WorkspaceBoundaryError);
  });
});

describe("previewWorkspaceFile", () => {
  test("文本文件返回 text", async () => {
    const preview = await previewWorkspaceFile(workspace, "readme.md");
    expect(preview).toEqual({ kind: "text", text: "# hello", truncated: false, size: 7 });
  });

  test("含 NUL 的文件按二进制处理", async () => {
    const preview = await previewWorkspaceFile(workspace, "bin.dat");
    expect(preview.kind).toBe("binary");
  });

  test("目录/越界拒绝", async () => {
    await expect(previewWorkspaceFile(workspace, "src")).rejects.toThrow("Not a file");
    await expect(previewWorkspaceFile(workspace, "../outside.txt")).rejects.toThrow(WorkspaceBoundaryError);
  });
});

describe("rename/delete", () => {
  test("重命名限同目录、名称不得含分隔符;root 本身不可动", () => {
    writeFileSync(join(root, "old.txt"), "x");
    renameWorkspaceEntry(workspace, "old.txt", "new.txt");
    expect(existsSync(join(root, "new.txt"))).toBe(true);
    expect(() => renameWorkspaceEntry(workspace, "new.txt", "../escape.txt")).toThrow();
    expect(() => renameWorkspaceEntry(workspace, "", "anything")).toThrow("Cannot rename the workspace root");
  });

  test("删除文件与目录;root 本身不可删", () => {
    writeFileSync(join(root, "src", "tmp.txt"), "x");
    deleteWorkspaceEntry(workspace, "src/tmp.txt");
    expect(existsSync(join(root, "src", "tmp.txt"))).toBe(false);
    expect(() => deleteWorkspaceEntry(workspace, "")).toThrow("Cannot delete the workspace root");
    expect(() => deleteWorkspaceEntry(workspace, "../outside.txt")).toThrow(WorkspaceBoundaryError);
    expect(existsSync(join(host, "outside.txt"))).toBe(true);
  });
});
