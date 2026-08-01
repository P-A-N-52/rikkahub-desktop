// backup/workspace-android-contract.test.ts — M4-4 跨端契约回归(§9.1B)。
// M3-2 单测只验适配器本身;导出真实管线是"adapt → wrap"两步(export.ts fixParts 的 tool 分支)。
// 本文件锁这两步的组合产物,断言两件事:
//   1) 有适配层=原生渲染:四个工具改名 workspace_*,content/input 键位精确对齐安卓
//      WorkspaceToolUIs 读取口径(read/write/edit/shell),edit 的 diff 透传进 metadata;
//   2) 无适配层也不炸:导出后每个 output 条目都带字符串 type 判别符——安卓 ToolResult 多态
//      解码永不抛(read 失败载荷这类"无判别符"条目由 wrap 兜底成 text part)。
// 用一条含四工具×成功/失败/待审批的完整 agent 助手消息做夹具,贴近真实导出。
import { describe, expect, test } from "bun:test";
import { adaptWorkspaceToolPartForAndroid } from "./workspace-android-export";
import { wrapToolOutputEntriesForAndroid } from "./export";

/** 精确复刻 export.ts insertConversationsIntoDb 里 fixParts 的 tool 分支(adapt 后 wrap)。 */
function exportToolPart(p: Record<string, unknown>): Record<string, unknown> {
  if (p.type !== "tool") return { ...p };
  const fixed = adaptWorkspaceToolPartForAndroid({ ...p });
  if (Array.isArray(fixed.output)) fixed.output = wrapToolOutputEntriesForAndroid(fixed.output);
  return fixed;
}

function toolPart(toolName: string, input: Record<string, unknown>, output: unknown[] = []) {
  return {
    type: "tool",
    toolCallId: `c-${toolName}`,
    toolName,
    input: JSON.stringify(input),
    output,
    approvalState: { type: "auto" },
  } as Record<string, unknown>;
}

/** 安卓 content = output 中 text 条目拼接后 JSON 解析。取首个 text 条目文本解析。 */
function content(part: Record<string, unknown>): Record<string, unknown> {
  const first = (part.output as Array<{ type?: string; text?: string }>).find((e) => e.type === "text");
  return JSON.parse(first!.text!);
}

// 一整轮 agent:读文件→改文件→写新文件→跑构建(失败)→再跑成功命令→一个待审批 bash→一个 MCP 工具。
const conversationToolParts: Record<string, unknown>[] = [
  toolPart("read", { path: "src/app.ts", offset: 1, limit: 200 }, [{ type: "text", text: "export const x = 1\n" }]),
  toolPart("edit", { path: "src/app.ts", edits: [{ oldText: "x = 1", newText: "x = 2" }] }, [
    { type: "text", text: "Applied 1 edit", metadata: { workspace: { tool: "edit", details: { diff: "@@\n-x = 1\n+x = 2" } } } },
  ]),
  toolPart("write", { path: "docs/notes.md", content: "# Notes\n" }, [{ type: "text", text: "File written (8 bytes)" }]),
  toolPart("bash", { command: "npm run build" }, [{ error: "tsc failed\n\nCommand exited with code 2" }]),
  toolPart("bash", { command: "ls -la" }, [
    { type: "text", text: "total 8\napp.ts", metadata: { workspace: { tool: "bash", details: { exitCode: 0 } } } },
  ]),
  toolPart("bash", { command: "rm -rf /tmp/build" }), // 待审批:output 为空
  toolPart("read", { path: "missing.txt" }, [{ error: "File not found: missing.txt" }]), // 失败:无判别符载荷
  { type: "tool", toolCallId: "c-mcp", toolName: "mcp__srv__fetch", input: JSON.stringify({ url: "http://x" }), output: [{ type: "text", text: "ok" }] },
  { type: "text", text: "全部完成。" },
];

describe("跨端契约:有适配层=原生渲染", () => {
  const exported = conversationToolParts.map(exportToolPart);

  test("read → workspace_read_file,content {path,text}", () => {
    const p = exported[0]!;
    expect(p.toolName).toBe("workspace_read_file");
    expect(content(p)).toEqual({ path: "src/app.ts", text: "export const x = 1\n" });
  });

  test("edit → workspace_edit_file,input 单组 old/new_text,diff 透传进 metadata", () => {
    const p = exported[1]!;
    expect(p.toolName).toBe("workspace_edit_file");
    expect(JSON.parse(p.input as string)).toEqual({ path: "src/app.ts", old_text: "x = 1", new_text: "x = 2" });
    const out = p.output as Array<{ type: string; text: string; metadata?: { diff?: string } }>;
    expect(out[0].metadata?.diff).toBe("@@\n-x = 1\n+x = 2"); // 安卓 DiffMetadata,wrap 未清洗(已带 type)
    expect(content(p)).toEqual({ path: "src/app.ts", replacements: 1 });
  });

  test("write → workspace_write_file,input.content 改名 text", () => {
    const p = exported[2]!;
    expect(p.toolName).toBe("workspace_write_file");
    expect(JSON.parse(p.input as string)).toEqual({ path: "docs/notes.md", text: "# Notes\n" });
    expect(content(p)).toEqual({ path: "docs/notes.md" });
  });

  test("bash 失败 → workspace_shell,状态行反解 exitCode,全文进 stderr", () => {
    const p = exported[3]!;
    expect(p.toolName).toBe("workspace_shell");
    expect(content(p)).toEqual({ exitCode: 2, stdout: "", stderr: "tsc failed\n\nCommand exited with code 2", timedOut: false });
  });

  test("bash 成功 → workspace_shell,content.{exitCode,stdout,stderr,timedOut}", () => {
    const p = exported[4]!;
    expect(content(p)).toEqual({ exitCode: 0, stdout: "total 8\napp.ts", stderr: "", timedOut: false });
  });

  test("待审批 bash 仅改名,output 空(安卓按 arguments 预览)", () => {
    const p = exported[5]!;
    expect(p.toolName).toBe("workspace_shell");
    expect(p.output).toEqual([]);
  });

  test("MCP 工具不被工作区适配层触碰(名字与载荷原样)", () => {
    const p = exported[7]!;
    expect(p.toolName).toBe("mcp__srv__fetch");
    expect(p.output).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("跨端契约:无适配层也不炸(每个 output 条目都可多态解码)", () => {
  test("导出后所有 tool 部件的 output 条目均带字符串 type 判别符", () => {
    const exported = conversationToolParts.map(exportToolPart);
    for (const p of exported) {
      if (p.type !== "tool" || !Array.isArray(p.output)) continue;
      for (const entry of p.output as unknown[]) {
        expect(entry && typeof entry === "object" && !Array.isArray(entry)).toBe(true);
        expect(typeof (entry as { type?: unknown }).type).toBe("string");
      }
    }
  });

  test("read 失败的无判别符载荷被 wrap 兜底成 text part(否则安卓解码即炸)", () => {
    const p = conversationToolParts[6]!;
    const raw = adaptWorkspaceToolPartForAndroid({ ...p });
    // 适配器对失败 read 不映射,留原始 {error} 条目(无 type)
    expect((raw.output as Array<Record<string, unknown>>)[0]!.type).toBeUndefined();
    // 导出两步后被包装成 text part,text 内含原始 JSON
    const exported = exportToolPart(p);
    const entry = (exported.output as Array<{ type: string; text: string }>)[0]!;
    expect(entry.type).toBe("text");
    expect(JSON.parse(entry.text)).toEqual({ error: "File not found: missing.txt" });
  });
});
