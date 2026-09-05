// tests/message-grouping.test.ts — 消息分组与工作区动作失败判定(抽屉合并方案)
//
// 分组契约(用户 2026-09-05 拍板):连续 reasoning/工具合并进一张思维链大卡;
// 抽出成独立卡的语义唯一=需要用户注意(pending 审批/终局失败的工作区动作);
// 正文(text/媒体/loading)切卡。
import { describe, expect, test } from "bun:test";

import { groupMessageParts } from "~/lib/message-grouping";
import { isFailedWorkspaceAction } from "~/lib/workspace-tool-model";
import type { ReasoningPart, TextPart, ToolPart } from "~/types";

let seq = 0;
function tool(toolName: string, over: Partial<ToolPart> = {}): ToolPart {
  seq += 1;
  return {
    type: "tool",
    toolCallId: `call-${seq}`,
    toolName,
    input: "{}",
    output: [],
    approvalState: { type: "auto" },
    ...over,
  };
}

function bashWithExit(exitCode: number, text = ""): ToolPart {
  return tool("bash", {
    output: [
      {
        type: "text",
        text,
        metadata: { workspace: { details: { exitCode } } },
      },
    ],
  });
}

function reasoning(): ReasoningPart {
  return { type: "reasoning", reasoning: "thinking..." };
}

function text(content = "回复正文"): TextPart {
  return { type: "text", text: content };
}

describe("isFailedWorkspaceAction:终局失败判定", () => {
  test("非工作区工具/只读 read 恒不失败(即使带 error 载荷)", () => {
    expect(isFailedWorkspaceAction(tool("search_web", { output: [{ error: "boom" }] }))).toBe(false);
    expect(isFailedWorkspaceAction(tool("read", { output: [{ error: "boom" }] }))).toBe(false);
  });

  test("被拒动作即失败(无需输出到位)", () => {
    expect(
      isFailedWorkspaceAction(tool("write", { approvalState: { type: "denied", reason: "不行" } })),
    ).toBe(true);
  });

  test("error 载荷即失败;安卓别名 toolName 同判", () => {
    expect(isFailedWorkspaceAction(tool("edit", { output: [{ error: "no match" }] }))).toBe(true);
    expect(
      isFailedWorkspaceAction(tool("workspace_shell", { output: [{ error: "spawn failed" }] })),
    ).toBe(true);
  });

  test("bash 非零退出失败,零退出成功", () => {
    expect(isFailedWorkspaceAction(bashWithExit(1, "err"))).toBe(true);
    expect(isFailedWorkspaceAction(bashWithExit(0, "ok"))).toBe(false);
  });

  test("未终局不算失败:无输出(排队/执行中)与流式文本无结构化 exitCode", () => {
    expect(isFailedWorkspaceAction(tool("bash"))).toBe(false);
    expect(
      isFailedWorkspaceAction(tool("bash", { output: [{ type: "text", text: "partial..." }] })),
    ).toBe(false);
  });
});

describe("groupMessageParts:抽屉合并分组", () => {
  test("连续 reasoning+普通工具+成功动作合并进同一张思维链大卡", () => {
    const blocks = groupMessageParts([
      reasoning(),
      tool("read"),
      tool("write", { output: [{ type: "text", text: "Successfully wrote 10 bytes" }] }),
      bashWithExit(0, "done"),
      reasoning(),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("thinking");
    expect(blocks[0]?.type === "thinking" && blocks[0].steps).toHaveLength(5);
  });

  test("正文是切卡分界:思考→说话→动作 = 两张链卡夹一个 content", () => {
    const blocks = groupMessageParts([reasoning(), text(), bashWithExit(0)]);
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "content", "thinking"]);
  });

  test("终局失败的动作抽出为 failedWorkspaceAction,链被切分", () => {
    const failed = bashWithExit(1, "boom");
    const blocks = groupMessageParts([reasoning(), tool("read"), failed, reasoning(), bashWithExit(0)]);
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "failedWorkspaceAction", "thinking"]);
    expect(blocks[1]?.type === "failedWorkspaceAction" && blocks[1].tool.toolCallId).toBe(
      failed.toolCallId,
    );
  });

  test("pending 审批工具抽出为 pendingTool(等待决策不可折叠藏住)", () => {
    const blocks = groupMessageParts([reasoning(), tool("bash", { approvalState: { type: "pending" } })]);
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "pendingTool"]);
  });

  test("被拒动作走失败抽出而非留链", () => {
    const blocks = groupMessageParts([
      tool("edit", { approvalState: { type: "denied", reason: "危险" } }),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["failedWorkspaceAction"]);
  });

  test("运行中动作(无输出)留在链内,失败信号到达才弹出", () => {
    const runningBlocks = groupMessageParts([reasoning(), tool("bash")]);
    expect(runningBlocks.map((b) => b.type)).toEqual(["thinking"]);

    const failedBlocks = groupMessageParts([reasoning(), bashWithExit(127)]);
    expect(failedBlocks.map((b) => b.type)).toEqual(["thinking", "failedWorkspaceAction"]);
  });

  test("loading 占位符按 content 处理并切卡", () => {
    const blocks = groupMessageParts([reasoning(), { type: "loading" }]);
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "content"]);
  });
});
