import * as React from "react";
import { useTranslation } from "react-i18next";

import type { UIMessagePart } from "~/types";
import type { AssistantProfile } from "~/types";

import { ChainOfThought } from "./chain-of-thought";
import { AudioPart } from "./parts/audio-part";
import { DocumentPart } from "./parts/document-part";
import { ImagePart } from "./parts/image-part";
import { ReasoningStepPart } from "./parts/reasoning-step-part";
import { TextPart } from "./parts/text-part";
import { ToolPart as ToolStepPart, PendingToolAttentionCard } from "./parts/tool-part";
import { WorkspaceActionCard, WorkspaceActionStep } from "./parts/workspace-tool-part";
import { VideoPart } from "./parts/video-part";
import { TypingIndicator } from "~/components/ui/typing-indicator";
import { applyAssistantRegexes } from "~/lib/assistant-regex";
// 分组规则(抽屉合并方案,2026-09-05 拍板):连续 reasoning/工具调用合并进一张
// 思维链大卡;抽出成独立卡的语义唯一=需要用户注意(pending 审批/失败的工作区动作)。
// 纯函数与块类型定义在 lib/message-grouping.ts(可单测)。
import { groupMessageParts } from "~/lib/message-grouping";
import { isWorkspaceActionTool } from "~/lib/workspace-tool-model";

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

          if (block.type === "failedWorkspaceAction") {
            // 终局失败的工作区动作:红色状态常驻的顶层动作卡。运行中/成功的动作
            // 留在下方 thinking 链内(WorkspaceActionStep),失败信号到达才弹出。
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

            return (
              <ChainOfThought
                key={`thinking-${blockIndex}`}
                className="my-1"
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
                        isFirst={isFirst}
                        isLast={isLast}
                      />
                    );
                  }

                  const stepKey = step.tool.toolCallId || `${blockIndex}-${stepIndex}`;
                  if (isWorkspaceActionTool(step.tool.toolName)) {
                    // 工作区动作步骤:传消息级 loading(bash 流式中已有输出仍在运行,
                    // 终局以结构化 exitCode 为准,由步骤内部的 finished 判定)。
                    return (
                      <WorkspaceActionStep
                        key={stepKey}
                        tool={step.tool}
                        loading={loading}
                        isFirst={isFirst}
                        isLast={isLast}
                      />
                    );
                  }
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
