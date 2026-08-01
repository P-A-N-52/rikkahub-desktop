import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { cn } from "~/lib/utils";
import { useContainerTabsStore } from "~/stores/container-tabs-store";
import type { ConversationListDto } from "~/types";

// 二层会话标签(工作区 M2-1,方案 §4.2):比一层容器胶囊降一级——纯文字+关闭×,
// 高度更矮,底部 2px 激活指示条。标签题目用会话自动标题;"＋"回到本容器的"新对话"态。
// 状态在 container-tabs-store,路由 /c/:id 是权威,这里只发导航,由路由同步效应回写状态。

const EMPTY_TABS: string[] = [];

export function ConversationTabStrip({ conversations }: { conversations: ConversationListDto[] }) {
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
    <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-divider px-2 [scrollbar-width:none]">
      {tabs.map((conversationId) => {
        const active = conversationId === activeConversation;
        const title = titleById.get(conversationId)?.trim() || t("workspace.tabs.untitled");
        return (
          <div
            key={conversationId}
            className={cn(
              "group relative flex h-full max-w-44 shrink-0 cursor-pointer select-none items-center gap-1 px-2.5 text-xs transition-colors duration-150",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
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
                "flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity duration-150 hover:bg-muted",
                active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <X className="size-3" strokeWidth={1.75} />
            </span>
            {active ? (
              <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-primary" />
            ) : null}
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
        className="mb-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
