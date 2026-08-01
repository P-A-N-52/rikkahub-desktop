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
import {
  CreateFolderWorkspaceDialog,
  WorkspaceTrustDialog,
} from "~/components/workspace/workspace-create-dialogs";
import api from "~/services/api";
import {
  CHAT_CONTAINER,
  useContainerTabsStore,
  type ContainerKey,
} from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 一层容器标签栏(工作区 M2-1;前端重构A1 复刻 NewMax 浏览器式页签):
// 激活标签白底(bg-card)上圆角,与下方白色内容面板连成一体;非激活为画布上的
// 幽灵态。中键/×关闭(仅收起);拖拽排序;Ctrl+Tab 循环;溢出横滚+右端渐隐。
// 所在行落在沉浸标题栏高度带内,空白处穿透给 TitleBar 拖拽层(见 conversations.tsx)。

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
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
  // 信任门目标 + 拒绝语义:创建流拒绝=删除记录;重开已有未信任工作区拒绝=仅关门。
  const [trustTarget, setTrustTarget] = React.useState<{ workspace: WorkspaceDto; fromCreate: boolean } | null>(null);

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

  // 激活容器前的信任门(§3.3):folder 型未信任(含设置里撤销信任后)先过门,
  // 授权成功才真正进入;拒绝仅关门,不删已有工作区。
  const activateGuarded = React.useCallback(
    (key: ContainerKey) => {
      const workspace =
        key === CHAT_CONTAINER ? null : useWorkspaceStore.getState().workspaces.find((item) => item.id === key);
      if (workspace && workspace.type === "folder" && workspace.trustedAt == null) {
        setTrustTarget({ workspace, fromCreate: false });
        return;
      }
      navigateToContainer(key, navigate);
    },
    [navigate],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 items-end gap-[3px]">
      <div className="flex h-full min-w-0 items-end gap-[3px] overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
        {openTabs.map((key, index) => (
          <ContainerTab
            key={key}
            containerKey={key}
            workspace={key === CHAT_CONTAINER ? null : (workspaceById.get(key) ?? null)}
            active={key === activeTab}
            closable={openTabs.length > 1}
            dragging={dragKey === key}
            onActivate={() => activateGuarded(key)}
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
            className="mb-[5px] flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--ds-icon)] transition-colors duration-150 hover:bg-[var(--ds-on-surface)] hover:text-foreground"
          >
            <Plus className="size-[18px]" strokeWidth={1.75} />
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
          <DropdownMenuItem onSelect={() => setFolderDialogOpen(true)}>
            <FolderOpen className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.folder")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.folder_hint")}
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

      <CreateFolderWorkspaceDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
        onCreated={(workspace) => setTrustTarget({ workspace, fromCreate: true })}
      />
      <WorkspaceTrustDialog
        workspace={trustTarget?.workspace ?? null}
        onOpenChange={(open) => {
          if (!open) setTrustTarget(null);
        }}
        onDeclinedDelete={trustTarget?.fromCreate ?? false}
        onTrusted={(workspace) => {
          useContainerTabsStore.getState().openContainer(workspace.id);
          navigateToContainer(workspace.id, navigate);
        }}
      />
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

  // NewMax WorkspaceTab 原样移植:28px 高页签,激活态与下方面板(surface-200)连体——
  // 底部 3px 连接条 + 两侧 radial-gradient 反圆角(R=13),白色顶内衬制造受光面。
  const TAB_CORNER_R = 13;
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
      className={cn("relative shrink-0 select-none pb-[3px]", dragging && "opacity-60")}
      style={
        active
          ? {
              filter: "drop-shadow(rgba(0, 0, 0, 0.08) 0px 0px 0.5px)",
              clipPath: "inset(-2px -15px -2px -15px)",
            }
          : undefined
      }
    >
      <div
        className={cn(
          "group relative flex h-7 max-w-44 items-center gap-1.5 pl-2.5 pr-1.5 text-[13px] font-medium transition-colors duration-150",
          active
            ? "rounded-t-[10px] bg-[var(--ds-surface-200)] text-[var(--ds-text-primary)]"
            : "rounded-[10px] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
        )}
      >
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
        {closable ? (
          <span
            role="button"
            aria-label={t("workspace.tabs.close")}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded-full opacity-0 transition-all duration-150 group-hover:ml-0.5 group-hover:w-5 group-hover:opacity-100 hover:bg-[var(--ds-on-surface)]"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </span>
        ) : null}
        {active ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-t-[10px]"
            style={{ boxShadow: "inset 0 0.5px 0 0 rgba(255, 255, 255, 0.2)" }}
          />
        ) : null}
      </div>
      {active ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center">
          <div className="h-[3px] flex-1 bg-[var(--ds-surface-200)]" />
          <div
            className="absolute"
            style={{
              left: -TAB_CORNER_R,
              bottom: -2,
              width: TAB_CORNER_R,
              height: TAB_CORNER_R + 2,
              background: `radial-gradient(circle ${TAB_CORNER_R}px at 0 0, transparent ${TAB_CORNER_R - 0.5}px, var(--ds-surface-200) ${TAB_CORNER_R}px)`,
            }}
          />
          <div
            className="absolute"
            style={{
              right: -TAB_CORNER_R,
              bottom: -2,
              width: TAB_CORNER_R,
              height: TAB_CORNER_R + 2,
              background: `radial-gradient(circle ${TAB_CORNER_R}px at 100% 0, transparent ${TAB_CORNER_R - 0.5}px, var(--ds-surface-200) ${TAB_CORNER_R}px)`,
            }}
          />
        </div>
      ) : null}
    </button>
  );
}
