import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Folder, FolderOpen, MessageSquare, Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import {
  CHAT_CONTAINER,
  useContainerTabsStore,
  type ContainerKey,
} from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 一层容器标签栏(工作区 M2-1,方案 §4.1):软圆角胶囊标签,激活白底浮起;
// 图标区分容器类型;中键/×关闭(仅收起);拖拽排序;Ctrl+Tab 循环;溢出横滚+右端渐隐。
// 在 Tauri 里嵌入沉浸式标题栏的中央拖拽区(标签是 button,标题栏 mousedown 处理器
// 会跳过 button 目标,拖拽窗口与点击标签互不干扰)。

/** 点击/循环切换容器:激活并导航到该容器上次停留的会话(无则回"新对话"首页)。 */
function navigateToContainer(key: ContainerKey, navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  store.activateContainer(key);
  const conversationId = store.activeConversation[key];
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

export function ContainerTabBar() {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const openTabs = useContainerTabsStore((state) => state.openTabs);
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const [dragKey, setDragKey] = React.useState<ContainerKey | null>(null);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // 工作区被删除(本端或其他窗口)后清理指向它的标签,activeTab 回落由 store 保证。
  React.useEffect(() => {
    if (!loaded) return;
    useContainerTabsStore
      .getState()
      .pruneWorkspaces(new Set(workspaces.map((workspace) => workspace.id)));
  }, [loaded, workspaces]);

  // Ctrl+Tab / Ctrl+Shift+Tab 循环切换容器(方案 §4.1)。
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== "Tab") return;
      event.preventDefault();
      const { openTabs: tabs, activeTab: active } = useContainerTabsStore.getState();
      if (tabs.length < 2) return;
      const index = tabs.indexOf(active);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
      navigateToContainer(next, navigate);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  const workspaceById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  const closeTab = React.useCallback(
    (key: ContainerKey) => {
      const store = useContainerTabsStore.getState();
      const wasActive = store.activeTab === key;
      store.closeContainer(key);
      if (wasActive) navigateToContainer(useContainerTabsStore.getState().activeTab, navigate);
    },
    [navigate],
  );

  const createManagedWorkspace = React.useCallback(async () => {
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>("workspaces", { type: "managed" });
      await refresh();
      useContainerTabsStore.getState().openContainer(res.workspace.id);
      navigate("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.create.failed"));
    }
  }, [navigate, refresh, t]);

  const openChatContainer = React.useCallback(() => {
    useContainerTabsStore.getState().openContainer(CHAT_CONTAINER);
    navigateToContainer(CHAT_CONTAINER, navigate);
  }, [navigate]);

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1">
      <div
        className="flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]"
        data-tauri-drag-region
      >
        {openTabs.map((key, index) => (
          <ContainerTab
            key={key}
            containerKey={key}
            workspace={key === CHAT_CONTAINER ? null : (workspaceById.get(key) ?? null)}
            active={key === activeTab}
            closable={openTabs.length > 1}
            dragging={dragKey === key}
            onActivate={() => navigateToContainer(key, navigate)}
            onClose={() => closeTab(key)}
            onDragStart={() => setDragKey(key)}
            onDragEnd={() => setDragKey(null)}
            onDragOverTab={() => {
              if (dragKey && dragKey !== key) {
                useContainerTabsStore.getState().reorderContainer(dragKey, index);
              }
            }}
          />
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("workspace.tabs.new_container")}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={() => void createManagedWorkspace()}>
            <Folder className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.managed")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.managed_hint")}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openChatContainer}>
            <MessageSquare className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.chat")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.chat_hint")}
              </div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ContainerTab({
  containerKey,
  workspace,
  active,
  closable,
  dragging,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
  onDragOverTab,
}: {
  containerKey: ContainerKey;
  workspace: WorkspaceDto | null;
  active: boolean;
  closable: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTab: () => void;
}) {
  const { t } = useTranslation("page");
  const isChat = containerKey === CHAT_CONTAINER;
  const label = isChat
    ? t("workspace.tabs.chat")
    : (workspace?.name ?? t("workspace.tabs.missing"));
  const Icon = isChat ? MessageSquare : workspace?.type === "folder" ? FolderOpen : Folder;
  // folder 型 hover 展示真实路径(方案 §4.1);managed 型路径是应用托管目录,不打扰。
  const tooltip = workspace?.type === "folder" ? workspace.root : label;

  return (
    <button
      type="button"
      draggable
      title={tooltip}
      onClick={onActivate}
      onAuxClick={(event) => {
        if (event.button === 1 && closable) onClose();
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverTab();
      }}
      className={cn(
        "group flex h-7 max-w-40 shrink-0 select-none items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors duration-150",
        active
          ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),inset_0_0_0_1px_var(--divider,rgba(0,0,0,0.04))]"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        dragging && "opacity-60",
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{label}</span>
      {closable ? (
        <span
          role="button"
          aria-label={t("workspace.tabs.close")}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity duration-150 hover:bg-muted",
            active
              ? "opacity-60 hover:opacity-100"
              : "opacity-0 group-hover:opacity-60 hover:group-hover:opacity-100",
          )}
        >
          <X className="size-3" strokeWidth={1.75} />
        </span>
      ) : null}
    </button>
  );
}
