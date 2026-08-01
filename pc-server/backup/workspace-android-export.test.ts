// backup/workspace-android-export.test.ts — §9.1B 导出适配层单测（纯函数）。

import { describe, expect, test } from "bun:test";
import { adaptWorkspaceToolPartForAndroid } from "./workspace-android-export";

function part(toolName: string, input: Record<string, unknown>, output: unknown[] = []) {
  return {
    type: "tool",
    toolCallId: "c1",
    toolName,
    input: JSON.stringify(input),
    output,
    approvalState: { type: "auto" },
  } as Record<string, unknown>;
}

function contentOf(adapted: Record<string, unknown>): Record<string, unknown> {
  const output = adapted.output as Array<{ text: string }>;
  return JSON.parse(output[0].text);
}

describe("adaptWorkspaceToolPartForAndroid", () => {
  test("read → workspace_read_file,输出包 {path,text}", () => {
    const adapted = adaptWorkspaceToolPartForAndroid(
      part("read", { path: "src/a.ts", offset: 3 }, [{ type: "text", text: "line1\nline2" }]),
    );
    expect(adapted.toolName).toBe("workspace_read_file");
    expect(contentOf(adapted)).toEqual({ path: "src/a.ts", text: "line1\nline2" });
  });

  test("write → workspace_write_file,入参 content 改名 text", () => {
    const adapted = adaptWorkspaceToolPartForAndroid(
      part("write", { path: "b.md", content: "hello" }, [{ type: "text", text: "File written" }]),
    );
    expect(adapted.toolName).toBe("workspace_write_file");
    expect(JSON.parse(adapted.input as string)).toEqual({ path: "b.md", text: "hello" });
    expect(contentOf(adapted)).toEqual({ path: "b.md" });
  });

  test("edit → workspace_edit_file,diff 平铺进 output[0].metadata(安卓 DiffMetadata)", () => {
    const adapted = adaptWorkspaceToolPartForAndroid(
      part("edit", { path: "c.py", edits: [{ oldText: "a", newText: "b" }] }, [{
        type: "text",
        text: "edited",
        metadata: { workspace: { tool: "edit", details: { diff: "--- c.py\n-a\n+b" } } },
      }]),
    );
    expect(adapted.toolName).toBe("workspace_edit_file");
    expect(JSON.parse(adapted.input as string)).toEqual({ path: "c.py", old_text: "a", new_text: "b" });
    const output = adapted.output as Array<{ text: string; metadata?: { diff?: string } }>;
    expect(output[0].metadata?.diff).toBe("--- c.py\n-a\n+b");
    expect(JSON.parse(output[0].text)).toEqual({ path: "c.py", replacements: 1 });
  });

  test("edit 多组 edits 不硬凑 old_text/new_text", () => {
    const adapted = adaptWorkspaceToolPartForAndroid(
      part("edit", { path: "d.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, [
        { type: "text", text: "edited" },
      ]),
    );
    expect(JSON.parse(adapted.input as string)).toEqual({ path: "d.ts" });
    expect(contentOf(adapted).replacements).toBe(2);
  });

  test("bash 成功 → workspace_shell,content 含 exitCode/stdout", () => {
    const adapted = adaptWorkspaceToolPartForAndroid(
      part("bash", { command: "ls" }, [{
        type: "text",
        text: "a.txt\nb.txt",
        metadata: { workspace: { tool: "bash", details: { exitCode: 0 } } },
      }]),
    );
    expect(adapted.toolName).toBe("workspace_shell");
    expect(contentOf(adapted)).toEqual({ exitCode: 0, stdout: "a.txt\nb.txt", stderr: "", timedOut: false });
  });

  test("bash 失败 → 从报错状态行反解 exitCode/timedOut", () => {
    const failed = adaptWorkspaceToolPartForAndroid(
      part("bash", { command: "make" }, [{ error: "build broke\n\nCommand exited with code 2" }]),
    );
    expect(contentOf(failed)).toEqual({ exitCode: 2, stdout: "", stderr: "build broke\n\nCommand exited with code 2", timedOut: false });
    const timedOut = adaptWorkspaceToolPartForAndroid(
      part("bash", { command: "sleep 99" }, [{ error: "partial\n\nCommand timed out after 30 seconds" }]),
    );
    expect(contentOf(timedOut).timedOut).toBe(true);
    expect(contentOf(timedOut).exitCode).toBeUndefined();
  });

  test("read 失败载荷不映射(留 wrap 兜底);未执行仅改名", () => {
    const failed = adaptWorkspaceToolPartForAndroid(part("read", { path: "x" }, [{ error: "not found" }]));
    expect(failed.toolName).toBe("workspace_read_file");
    expect(failed.output).toEqual([{ error: "not found" }]);
    const pending = adaptWorkspaceToolPartForAndroid(part("bash", { command: "rm -rf /" }));
    expect(pending.toolName).toBe("workspace_shell");
    expect(pending.output).toEqual([]);
  });

  test("非工作区工具与已是安卓名的 part 原样返回", () => {
    const mcp = part("mcp__srv__fetch", { url: "http://x" });
    expect(adaptWorkspaceToolPartForAndroid(mcp)).toBe(mcp);
    const androidNative = part("workspace_shell", { command: "ls" }, [{ type: "text", text: "{}" }]);
    expect(adaptWorkspaceToolPartForAndroid(androidNative)).toBe(androidNative);
  });
});
