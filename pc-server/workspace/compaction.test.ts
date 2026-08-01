// workspace/compaction.test.ts — agent 压缩输入构建的单测（纯函数，无 IO）。

import { describe, expect, test } from "bun:test";
import type { Message, ToolPart } from "../foundation/types";
import { agentSummaryAsText, buildAgentCompactionContext, extractAgentActivity, toolSummaryLine } from "./compaction";

function toolPart(toolName: string, input: Record<string, unknown>, overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    type: "tool",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
    output: [{ type: "text", text: "ok" }],
    approvalState: { type: "auto" },
    ...overrides,
  } as ToolPart;
}

function msg(parts: Message["parts"]): Message {
  return { role: "ASSISTANT", parts } as Message;
}

describe("toolSummaryLine", () => {
  test("四类工具产可读单行摘要", () => {
    expect(toolSummaryLine(toolPart("read", { path: "src/a.ts" }))).toBe("[tool] read src/a.ts");
    expect(toolSummaryLine(toolPart("write", { path: "b.md" }))).toBe("[tool] write b.md");
    expect(toolSummaryLine(toolPart("edit", { path: "c.py" }))).toBe("[tool] edit c.py");
    expect(toolSummaryLine(toolPart("bash", { command: "npm test" }))).toBe("[tool] $ npm test");
  });

  test("安卓别名同样识别", () => {
    expect(toolSummaryLine(toolPart("workspace_read_file", { path: "x" }))).toBe("[tool] read x");
    expect(toolSummaryLine(toolPart("workspace_shell", { command: "ls" }))).toBe("[tool] $ ls");
  });

  test("bash 带结构化 exitCode 时标注", () => {
    const part = toolPart("bash", { command: "make" }, {
      output: [{ type: "text", text: "out", metadata: { workspace: { tool: "bash", details: { exitCode: 2 } } } }],
    });
    expect(toolSummaryLine(part)).toBe("[tool] $ make (exit 2)");
  });

  test("失败工具标注 failed；未知工具回退工具名", () => {
    const failed = toolPart("edit", { path: "a" }, { output: [{ error: "boom" }] });
    expect(toolSummaryLine(failed)).toBe("[tool] edit a (failed)");
    expect(toolSummaryLine(toolPart("mcp__server__thing", {}))).toBe("[tool] mcp__server__thing");
  });

  test("入参损坏不炸", () => {
    const broken = toolPart("read", {}, { input: "{not json" });
    expect(toolSummaryLine(broken)).toBe("[tool] read ?");
  });
});

describe("agentSummaryAsText", () => {
  test("无工具 part 时返回原摘要", () => {
    expect(agentSummaryAsText(msg([{ type: "text", text: "hi" }]), "[ASSISTANT]: hi")).toBe("[ASSISTANT]: hi");
  });

  test("工具摘要行追加在文本摘要之后", () => {
    const value = agentSummaryAsText(
      msg([{ type: "text", text: "done" }, toolPart("bash", { command: "ls" })]),
      "[ASSISTANT]: done",
    );
    expect(value).toBe("[ASSISTANT]: done\n[tool] $ ls");
  });
});

describe("extractAgentActivity", () => {
  test("按类归集、去重保序、失败写入不算已修改", () => {
    const activity = extractAgentActivity([
      msg([toolPart("read", { path: "a.ts" }), toolPart("read", { path: "a.ts" })]),
      msg([toolPart("edit", { path: "b.ts" }), toolPart("write", { path: "c.ts" }, { output: [{ error: "denied" }] })]),
      msg([toolPart("bash", { command: "bun test" })]),
    ]);
    expect(activity.readFiles).toEqual(["a.ts"]);
    expect(activity.modifiedFiles).toEqual(["b.ts"]);
    expect(activity.commands).toEqual(["bun test"]);
  });

  test("无工具活动返回空清单", () => {
    const activity = extractAgentActivity([msg([{ type: "text", text: "chat only" }])]);
    expect(activity).toEqual({ readFiles: [], modifiedFiles: [], commands: [] });
  });
});

describe("buildAgentCompactionContext", () => {
  test("空活动返回空串（不污染 chat 压缩提示词）", () => {
    expect(buildAgentCompactionContext({ readFiles: [], modifiedFiles: [], commands: [] })).toBe("");
  });

  test("清单结构化注入且超长截断", () => {
    const text = buildAgentCompactionContext({
      readFiles: Array.from({ length: 60 }, (_, i) => `f${i}.ts`),
      modifiedFiles: ["m.ts"],
      commands: ["npm i"],
    });
    expect(text).toContain("Files read:");
    expect(text).toContain("…and 10 more");
    expect(text).toContain("Files modified:\n  - m.ts");
    expect(text).toContain("Commands run:\n  - npm i");
  });
});
