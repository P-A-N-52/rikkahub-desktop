import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { cn } from "~/lib/utils";
import { useContainerTabsStore } from "~/stores/container-tabs-store";
import type { ConversationListDto } from "~/types";

// 二层会话标签(工作区 M2-1;前端重构A1 复刻 NewMax):白色内容面板的顶缘胶囊行,
// 激活项奶油底胶囊,非激活幽灵态。标签题目用会话自动标题;"＋"回到本容器的"新对话"态。
// trailing 是行尾动作位(如会话级自定义提示词入口)。状态在 container-tabs-store,
// 路由 /c/:id 是权威,这里只发导航,由路由同步效应回写状态。

const EMPTY_TABS: string[] = [];

export function ConversationTabStrip({
  conversations,
  trailing,
}: {
  conversations: ConversationListDto[];
  trailing?: React.ReactNode;
}) {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const tabs = useContainerTabsStore(
    (state) => state.conversationTabs[state.activeTab] ?? EMPTY_TABS,
  );
  const activeConversation = useContainerTabsStore(
    (state) => state.activeConversation[state.activeTab] ?? null,
  );

  const titleById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const item of conversations) map.set(item.id, item.title);
    return map;
  }, [conversations]);

  if (tabs.length === 0) return null;

  const handleClose = (conversationId: string) => {
    const next = useContainerTabsStore.getState().closeConversation(activeTab, conversationId);
    if (next !== undefined) navigate(next ? `/c/${next}` : "/");
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {tabs.map((conversationId) => {
        const active = conversationId === activeConversation;
        const title = titleById.get(conversationId)?.trim() || t("workspace.tabs.untitled");
        return (
          <div
            key={conversationId}
            className={cn(
              "group relative flex h-[26px] max-w-44 shrink-0 cursor-pointer select-none items-center gap-1 rounded-lg px-2.5 text-[13px] transition-colors duration-150",
              active
                ? "bg-[var(--ds-on-surface)] font-medium text-[var(--ds-text-primary)] shadow-[inset_0_0_0_0.5px_var(--ds-divider)]"
                : "text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
            )}
            title={title}
            onClick={() => {
              if (!active) navigate(`/c/${conversationId}`);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) handleClose(conversationId);
            }}
          >
            <span className="min-w-0 truncate">{title}</span>
            <span
              role="button"
              aria-label={t("workspace.tabs.close")}
              onClick={(event) => {
                event.stopPropagation();
                handleClose(conversationId);
              }}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity duration-150 hover:bg-[var(--ds-on-surface-active)]",
                active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <X className="size-3" strokeWidth={1.75} />
            </span>
          </div>
        );
      })}
      <button
        type="button"
        aria-label={t("workspace.tabs.new_conversation")}
        onClick={() => {
          useContainerTabsStore.getState().clearActiveConversation(activeTab);
          navigate("/");
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--ds-icon)] transition-colors duration-150 hover:bg-[var(--ds-on-surface)] hover:text-foreground"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
      </div>
      {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );
}
