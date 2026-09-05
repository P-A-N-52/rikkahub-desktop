import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { useConversationEngineStatus } from "~/stores/conversation-store";

// 会话瞬态状态条:压缩中/自动重试中。数据源是会话 SSE 的 engine-status 帧——
// 工作区会话由 pi 事件桥推送(P5),对话/工作区手动压缩由 compress 端点统一推送并在
// SSE 连接期补发快照(切页回来状态恢复)。无状态时不渲染,窄选择器订阅:只有本会话
// 状态跳变才重渲染,流式增量不经过这里。
export function EngineStatusBar({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation("page");
  const status = useConversationEngineStatus(conversationId);
  if (!status) return null;

  const text =
    status.phase === "retrying"
      ? t("conversations.engine_status.retrying", {
          attempt: status.attempt ?? 1,
          max: status.maxAttempts ?? 1,
        })
      : status.reason === "threshold" || status.reason === "overflow"
        ? t("conversations.engine_status.compacting_auto")
        : status.progress
          ? t("conversations.engine_status.compacting_progress", {
              current: status.progress.current,
              total: status.progress.total,
            })
          : t("conversations.engine_status.compacting");

  return (
    <div className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full border border-border/60 bg-muted/60 px-3 py-1 text-muted-foreground text-xs">
      <Loader2 className="size-3 shrink-0 animate-spin" />
      {text}
    </div>
  );
}
