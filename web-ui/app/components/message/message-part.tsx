import * as React from "react";
import { useTranslation } from "react-i18next";

import type { ReasoningPart, ToolPart, UIMessagePart } from "~/types";
import type { AssistantProfile } from "~/types";

import { ChainOfThought } from "./chain-of-thought";
import { AudioPart } from "./parts/audio-part";
import { DocumentPart } from "./parts/document-part";
import { ImagePart } from "./parts/image-part";
import { ReasoningPart as ReasoningFallbackPart } from "./parts/reasoning-part";
import { ReasoningStepPart } from "./parts/reasoning-step-part";
import { TextPart } from "./parts/text-part";
import { ToolPart as ToolStepPart, PendingToolAttentionCard } from "./parts/tool-part";
import { isWorkspaceActionTool, WorkspaceActionCard } from "./parts/workspace-tool-part";
import { VideoPart } from "./parts/video-part";
import { TypingIndicator } from "~/components/ui/typing-indicator";
import { applyAssistantRegexes } from "~/lib/assistant-regex";

type ThinkingStep =
  | {
      type: "reasoning";
      reasoning: ReasoningPart;
    }
  | {
      type: "tool";
      tool: ToolPart;
    };

type MessagePartBlock =
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
      // 任何 pending 状态的工具调用都必须从思考链折叠中抽出，作为独立的
      // attention 块渲染。否则 ChainOfThought 默认折叠态会把它藏在
      // "展开 N 个步骤"按钮后面，用户根本意识不到 AI 正在等待审批，
      // 误以为生成意外中止了。
      type: "pendingTool";
      tool: ToolPart;
      index: number;
    }
  | {
      // 工作区"改变世界"的动作(write/edit/bash,M2-3):从折叠组抽出为顶层动作卡。
      // 可见性分层(方案 §4.3):read 与思维链同认知层级留折叠;修改动作用户会看,
      // 必须是消息流一等公民。复用 pendingTool 的抽出机制,不新造流。
      type: "workspaceAction";
      tool: ToolPart;
      index: number;
    };

function isPendingTool(tool: ToolPart): boolean {
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
      if (isWorkspaceActionTool(part.toolName)) {
        flushThinkingSteps();
        result.push({ type: "workspaceAction", tool: part, index });
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

interface MessagePartsProps {
  parts: UIMessagePart[];
  loading?: boolean;
  assistant?: AssistantProfile | null;
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
  onClickCitation?: (id: string) => void;
  citationOrdinalMap?: Map<string, number>;
}

function renderContentPart(
  part: UIMessagePart,
  t: (key: string, options?: Record<string, unknown>) => string,
  loading?: boolean,
  onClickCitation?: (id: string) => void,
  assistant?: AssistantProfile | null,
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL",
  citationOrdinalMap?: Map<string, number>,
) {
  switch (part.type) {
    case "text":
      return (
        <TextPart
          text={applyAssistantRegexes(
            part.text,
            assistant,
            role === "USER" ? "USER" : "ASSISTANT",
            true,
          )}
          isAnimating={loading}
          onClickCitation={onClickCitation}
          citationOrdinalMap={citationOrdinalMap}
        />
      );
    case "image":
      return <ImagePart url={part.url} metadata={part.metadata} />;
    case "video":
      return <VideoPart url={part.url} />;
    case "audio":
      return <AudioPart url={part.url} />;
    case "document":
      return <DocumentPart url={part.url} fileName={part.fileName} mime={part.mime} />;
    case "reasoning":
      return (
        <ReasoningFallbackPart reasoning={part.reasoning} isFinished={part.finishedAt != null} />
      );
    case "tool":
      return (
        <div className="text-xs text-muted-foreground">{t("message_parts.tool_step_hint")}</div>
      );
    case "loading":
      return <TypingIndicator className="px-1 py-2" />;
  }
}

export const MessageParts = React.memo(
  ({
    parts,
    loading = false,
    assistant,
    role,
    onToolApproval,
    onClickCitation,
    citationOrdinalMap,
  }: MessagePartsProps) => {
    const { t } = useTranslation("message");
    const groupedParts = React.useMemo(() => groupMessageParts(parts), [parts]);
    const hasContentPart = React.useMemo(
      () =>
        parts.some((part) => {
          if (part.type === "text") return part.text.trim().length > 0;
          if (part.type === "image" || part.type === "video" || part.type === "audio")
            return part.url.trim().length > 0;
          if (part.type === "document")
            return part.url.trim().length > 0 || part.fileName.trim().length > 0;
          if (part.type === "loading") return false;
          return false;
        }),
      [parts],
    );
    // The backend inserts a `{type:"loading"}` placeholder while waiting for the first chunk; that
    // part already renders a TypingIndicator below, so the fallback waiting indicator would double
    // up when the only "part" is the placeholder. Treat the placeholder as the visible indicator.
    const hasLoadingPart = React.useMemo(
      () => parts.some((part) => part.type === "loading"),
      [parts],
    );
    const showWaitingIndicator = loading && !hasContentPart && !hasLoadingPart;

    return (
      <>
        {loading && parts.length === 0 ? <TypingIndicator className="px-1 py-2" /> : null}
        {groupedParts.map((block, blockIndex) => {
          if (block.type === "pendingTool") {
            // pending tool 从思考链中抽出，渲染独立 attention 卡片。ToolStepPart
            // 内部对 ask_user 已有专属醒目卡片；其它 pending tool 由我们在这里
            // 包一层 banner，明确告诉用户"AI 正在请求授权"，并显示工具名+参数+
            // 通过/拒绝按钮。
            return (
              <PendingToolAttentionCard
                key={`pending-tool-${block.tool.toolCallId || block.index}`}
                tool={block.tool}
                loading={loading && block.tool.output.length === 0}
                onToolApproval={onToolApproval}
              />
            );
          }

          if (block.type === "workspaceAction") {
            return (
              <WorkspaceActionCard
                key={`workspace-action-${block.tool.toolCallId || block.index}`}
                tool={block.tool}
                loading={loading}
              />
            );
          }

          if (block.type === "thinking") {
            if (block.steps.length === 0) return null;

            const isReasoningOnlyBlock = block.steps.every((step) => step.type === "reasoning");
            const hasLoadingReasoning = block.steps.some(
              (step) => step.type === "reasoning" && step.reasoning.finishedAt == null,
            );
            const enableAdaptiveWidth = isReasoningOnlyBlock && !hasLoadingReasoning;

            return (
              <ChainOfThought
                key={`thinking-${blockIndex}`}
                className="my-1"
                collapsedAdaptiveWidth={enableAdaptiveWidth}
                collapseLabel={t("message_parts.collapse_thinking")}
                showMoreLabel={(hiddenCount) =>
                  t("message_parts.expand_thinking_steps", { count: hiddenCount })
                }
                steps={block.steps}
                renderStep={(step, stepIndex, { isFirst, isLast }) => {
                  if (step.type === "reasoning") {
                    const stepKey = step.reasoning.createdAt ?? `${blockIndex}-${stepIndex}`;
                    return (
                      <ReasoningStepPart
                        key={stepKey}
                        reasoning={step.reasoning}
                        collapsedAdaptiveWidth={enableAdaptiveWidth}
                        isFirst={isFirst}
                        isLast={isLast}
                      />
                    );
                  }

                  const stepKey = step.tool.toolCallId || `${blockIndex}-${stepIndex}`;
                  return (
                    <ToolStepPart
                      key={stepKey}
                      tool={step.tool}
                      loading={loading && step.tool.output.length === 0}
                      onToolApproval={onToolApproval}
                      isFirst={isFirst}
                      isLast={isLast}
                    />
                  );
                }}
              />
            );
          }

          return (
            <React.Fragment key={`content-${block.index}`}>
              {renderContentPart(
                block.part,
                t,
                loading,
                onClickCitation,
                assistant,
                role,
                citationOrdinalMap,
              )}
            </React.Fragment>
          );
        })}
        {showWaitingIndicator && parts.length > 0 ? (
          <TypingIndicator className="px-1 py-2" />
        ) : null}
      </>
    );
  },
);

interface MessagePartProps {
  part: UIMessagePart;
  loading?: boolean;
  assistant?: AssistantProfile | null;
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
  onClickCitation?: (id: string) => void;
  citationOrdinalMap?: Map<string, number>;
}

export function MessagePart({
  part,
  loading,
  assistant,
  role,
  onToolApproval,
  onClickCitation,
  citationOrdinalMap,
}: MessagePartProps) {
  return (
    <MessageParts
      parts={[part]}
      loading={loading}
      assistant={assistant}
      role={role}
      onToolApproval={onToolApproval}
      onClickCitation={onClickCitation}
      citationOrdinalMap={citationOrdinalMap}
    />
  );
}
