// lib/message-grouping.ts — 消息 part 流的展示分组(纯函数,从 message-part.tsx 抽出)。
//
// 抽屉合并原则(用户 2026-09-05 拍板,修订工作区方案 §4.3):
// - 未被正文隔断的连续 reasoning/工具调用合并进同一张思维链大卡(ChainOfThought),
//   靠"默认只露尾部 N 步"的滑动窗口收敛纵向空间——工作区连续几十次调用也只占一张卡;
// - "抽出成独立卡"的语义唯一且清晰 = 需要用户注意:
//   * pending 审批/提问(等待用户决策,绝不能折叠藏住);
//   * 失败的工作区动作(被拒/错误/bash 非零退出——失败就该大声,例行成功保持安静);
// - 正文(text/媒体/loading)是切卡分界:模型"说一句话"即结束当前思考链。

import type { ReasoningPart, ToolPart, UIMessagePart } from "~/types";

import { isFailedWorkspaceAction } from "./workspace-tool-model";

export type ThinkingStep =
  | {
      type: "reasoning";
      reasoning: ReasoningPart;
    }
  | {
      type: "tool";
      tool: ToolPart;
    };

export type MessagePartBlock =
  | {
      type: "thinking";
      steps: ThinkingStep[];
    }
  | {
      type: "content";
      part: UIMessagePart;
      index: number;
    }
  | {
      // 任何 pending 状态的工具调用都必须从思考链折叠中抽出,作为独立的
      // attention 块渲染。否则 ChainOfThought 默认折叠态会把它藏在
      // "展开 N 个步骤"按钮后面,用户根本意识不到 AI 正在等待审批,
      // 误以为生成意外中止了。
      type: "pendingTool";
      tool: ToolPart;
      index: number;
    }
  | {
      // 终局失败的工作区动作(write/edit/bash):抽出为顶层动作卡,红色状态常驻。
      // 运行中/成功的动作留在思维链折叠组内(WorkspaceActionStep),失败信号到达
      // 的瞬间才"弹出"成卡——恰好发生在需要抓用户注意力的时刻。
      type: "failedWorkspaceAction";
      tool: ToolPart;
      index: number;
    };

export function isPendingTool(tool: ToolPart): boolean {
  return tool.approvalState?.type === "pending";
}

export function groupMessageParts(parts: UIMessagePart[]): MessagePartBlock[] {
  const result: MessagePartBlock[] = [];
  let currentThinkingSteps: ThinkingStep[] = [];

  const flushThinkingSteps = () => {
    if (currentThinkingSteps.length === 0) return;
    result.push({ type: "thinking", steps: currentThinkingSteps });
    currentThinkingSteps = [];
  };

  parts.forEach((part, index) => {
    if (part.type === "loading") {
      flushThinkingSteps();
      result.push({ type: "content", part, index });
      return;
    }

    if (part.type === "reasoning") {
      currentThinkingSteps.push({ type: "reasoning", reasoning: part });
      return;
    }

    if (part.type === "tool") {
      if (isPendingTool(part)) {
        flushThinkingSteps();
        result.push({ type: "pendingTool", tool: part, index });
        return;
      }
      if (isFailedWorkspaceAction(part)) {
        flushThinkingSteps();
        result.push({ type: "failedWorkspaceAction", tool: part, index });
        return;
      }
      currentThinkingSteps.push({ type: "tool", tool: part });
      return;
    }

    flushThinkingSteps();
    result.push({ type: "content", part, index });
  });

  flushThinkingSteps();
  return result;
}
