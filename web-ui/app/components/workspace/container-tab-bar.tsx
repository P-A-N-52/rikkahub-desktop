import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Folder, FolderOpen, FolderSearch, MessageSquare, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { confirmDialog } from "~/stores/confirm-store";
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
// 所在行是内容列撞色带顶部的纯交互行(原生标题栏负责窗控/拖拽,见 conversations.tsx)。

/** 点击/循环切换容器:激活并导航到该容器上次停留的会话(无则回"新对话"首页)。 */
function navigateToContainer(key: ContainerKey, navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  store.activateContainer(key);
  // J 轮分栏后:容器的"上次停留会话" = 聚焦窗格的激活会话。
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
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
  // R7 工作区管理:重命名对话框目标 + 输入值(提交 PATCH workspaces/:id)。
  const [renameTarget, setRenameTarget] = React.useState<WorkspaceDto | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);
  // B6-①b:编辑对话里 folder 型路径可重绑。renameRoot 是编辑中的路径草稿(初始=当前 root)。
  const [renameRoot, setRenameRoot] = React.useState("");

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

  // G4 右键批量关闭:store 更新后按新 activeTab 导航(可能落回原容器,导航幂等)。
  const closeTabsBatch = React.useCallback(
    (scope: "others" | "right" | "all", anchor: ContainerKey) => {
      useContainerTabsStore.getState().closeContainersBatch(scope, anchor);
      navigateToContainer(useContainerTabsStore.getState().activeTab, navigate);
    },
    [navigate],
  );

  // G4 在资源管理器中显示:path 空串 = 工作区根目录本身(explorer /select 选中)。
  const revealWorkspace = React.useCallback(
    (workspace: WorkspaceDto) => {
      void api
        .post(`workspaces/${workspace.id}/files/reveal`, { path: "" })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : t("workspace.menu.reveal_failed"));
        });
    },
    [t],
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

  // R7:从菜单激活已有工作区——folder 型未信任先过信任门,其余直接开标签并导航。
  const openWorkspaceFromMenu = React.useCallback(
    (workspace: WorkspaceDto) => {
      if (workspace.type === "folder" && workspace.trustedAt == null) {
        setTrustTarget({ workspace, fromCreate: false });
        return;
      }
      useContainerTabsStore.getState().openContainer(workspace.id);
      navigateToContainer(workspace.id, navigate);
    },
    [navigate],
  );

  const submitRename = React.useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    // B6-①b:folder 型且路径被改动 → 一并提交 root(后端重绑 + 信任门重置)。
    const root = renameTarget.type === "folder" ? renameRoot.trim() : "";
    const nameChanged = !!name && name !== renameTarget.name;
    const rootChanged = renameTarget.type === "folder" && !!root && root !== renameTarget.root;
    if (!nameChanged && !rootChanged) {
      setRenameTarget(null);
      return;
    }
    setRenameSaving(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${renameTarget.id}`, {
        ...(nameChanged ? { name } : {}),
        ...(rootChanged ? { root } : {}),
      });
      await refresh();
      setRenameTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(rootChanged ? "workspace.menu.rebind_failed" : "workspace.menu.rename_failed"));
    } finally {
      setRenameSaving(false);
    }
  }, [refresh, renameTarget, renameValue, renameRoot, t]);

  // 删除仅移除工作区记录与会话索引,不碰磁盘文件(folder 型的真实目录保持原样)。
  const deleteWorkspace = React.useCallback(
    async (workspace: WorkspaceDto) => {
      const ok = await confirmDialog({
        title: t("workspace.menu.delete_confirm_title", { name: workspace.name }),
        description: t("workspace.menu.delete_confirm_desc"),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`workspaces/${workspace.id}`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("workspace.menu.delete_failed"));
      }
    },
    [refresh, t],
  );

  const openChatContainer = React.useCallback(() => {
    useContainerTabsStore.getState().openContainer(CHAT_CONTAINER);
    navigateToContainer(CHAT_CONTAINER, navigate);
  }, [navigate]);

  // B6-①b:打开编辑对话时同步名称与路径草稿(folder 型路径可重绑)。
  const openEditDialog = React.useCallback((workspace: WorkspaceDto) => {
    setRenameValue(workspace.name);
    setRenameRoot(workspace.root);
    setRenameTarget(workspace);
  }, []);

  // B6-①b:目录选择器(Tauri);失败仅提示,不阻断手输路径。
  const browseRenameRoot = React.useCallback(async () => {
    try {
      const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
      const picked = await openPicker({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) setRenameRoot(picked);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.create.pick_failed"));
    }
  }, [t]);

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

  // NewMax getTabWidthCalc:页签宽度随数量在 58~172px 间按容器宽均分(容器查询
  // cqw),预留 77px 给 "+" 钮、边距与首标签 13px 左位——多开标签时像浏览器一样逐渐收窄。
  const tabWidthCalc = `clamp(58px, calc((100cqw - ${77 + Math.max(0, openTabs.length - 1) * 3}px) / ${Math.max(1, openTabs.length)}), 172px)`;

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-end gap-[3px]"
      style={{ containerType: "inline-size" }}
    >
      {/* I6:pl-[13px] 给首标签让出激活态左侧反圆角(R=13)的渲染空间(NewMax 同款右挪) */}
      <div className="flex h-full min-w-0 items-end gap-[3px] overflow-x-auto pl-[13px] [scrollbar-width:none]">
        {openTabs.map((key, index) => (
          <ContainerTab
            key={key}
            containerKey={key}
            workspace={key === CHAT_CONTAINER ? null : (workspaceById.get(key) ?? null)}
            width={tabWidthCalc}
            active={key === activeTab}
            closable={openTabs.length > 1}
            hasOthers={openTabs.length > 1}
            hasRight={index < openTabs.length - 1}
            dragging={dragKey === key}
            onActivate={() => activateGuarded(key)}
            onClose={() => closeTab(key)}
            onCloseOthers={() => closeTabsBatch("others", key)}
            onCloseRight={() => closeTabsBatch("right", key)}
            onCloseAll={() => closeTabsBatch("all", key)}
            onEdit={
              key === CHAT_CONTAINER
                ? undefined
                : () => {
                    const workspace = workspaceById.get(key);
                    if (workspace) openEditDialog(workspace);
                  }
            }
            onReveal={
              key === CHAT_CONTAINER
                ? undefined
                : () => {
                    const workspace = workspaceById.get(key);
                    if (workspace) revealWorkspace(workspace);
                  }
            }
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
          {/* R7:已有工作区列表——点击激活;行尾悬浮出重命名/删除(阻断 item 选中) */}
          {workspaces.length > 0 ? (
            <>
              <DropdownMenuLabel>{t("workspace.menu.existing")}</DropdownMenuLabel>
              {workspaces.map((workspace) => {
                const WsIcon = workspace.type === "folder" ? FolderOpen : Folder;
                return (
                  <DropdownMenuItem
                    key={workspace.id}
                    className="group/ws"
                    data-active={workspace.id === activeTab || undefined}
                    onSelect={() => openWorkspaceFromMenu(workspace)}
                  >
                    <WsIcon className="size-4" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{workspace.name}</span>
                        {workspace.status === "missing" ? (
                          <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[0.625rem] font-medium text-amber-600 dark:text-amber-400">
                            <TriangleAlert className="size-2.5" strokeWidth={2} />
                            {t("workspace.menu.missing_badge")}
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-[0.6875rem] leading-4 text-[var(--ds-text-tertiary)]">
                        {workspace.root}
                      </span>
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-[var(--ds-icon)] hover:bg-[var(--ds-on-surface-active)] hover:text-foreground"
                            onClick={() => openEditDialog(workspace)}
                          >
                            <Pencil className="size-3.5" strokeWidth={1.75} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("workspace.menu.rename")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-[var(--ds-icon)] hover:bg-[var(--ds-on-surface-active)] hover:text-destructive"
                            onClick={() => void deleteWorkspace(workspace)}
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.75} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("workspace.menu.delete")}</TooltipContent>
                      </Tooltip>
                    </span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </>
          ) : null}
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

      {/* G3 编辑工作区(NewMax 对位):名称可编辑,路径只读可点选(资源管理器中显示) */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspace.menu.edit_title")}</DialogTitle>
          </DialogHeader>
          {/* min-w-0:DialogContent 是 grid,不压住 auto 最小宽的话长路径会把格子撑出对话框 */}
          <div className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--ds-text-secondary)]">
                {t("workspace.menu.name_label")}
              </label>
              <Input
                value={renameValue}
                autoFocus
                placeholder={t("workspace.menu.rename_placeholder")}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--ds-text-secondary)]">
                {t("workspace.menu.path_label")}
              </label>
              {renameTarget?.type === "folder" ? (
                <>
                  {/* B6-①b:folder 型路径可重绑。missing 态显示失效警告;改路径后提示需重新授权信任。 */}
                  {renameTarget.status === "missing" ? (
                    <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] bg-amber-500/10 px-3 py-2 text-[0.75rem] text-amber-600 dark:text-amber-400">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
                      <span>{t("workspace.menu.missing_hint")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Input
                      value={renameRoot}
                      onChange={(event) => setRenameRoot(event.target.value)}
                      placeholder={t("workspace.create.folder_path_placeholder")}
                      className="flex-1 font-mono text-[0.8125rem]"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void browseRenameRoot()}>
                      <FolderSearch className="mr-1 size-4" />
                      {t("workspace.create.browse")}
                    </Button>
                  </div>
                  {renameRoot.trim() && renameRoot.trim() !== renameTarget.root ? (
                    <div className="text-[0.75rem] text-muted-foreground">{t("workspace.menu.rebind_notice")}</div>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => renameTarget && revealWorkspace(renameTarget)}
                  aria-label={t("workspace.menu.reveal")}
                  className="flex h-9 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-input)] px-3 text-left text-[0.8125rem] text-[var(--ds-text-secondary)] shadow-[var(--ds-input-shadow)] transition-shadow hover:shadow-[var(--ds-input-shadow-hover)]"
                >
                  <FolderOpen className="size-4 shrink-0 text-[var(--ds-icon)]" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{renameTarget?.root}</span>
                </button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("workspace.create.cancel")}
            </Button>
            <Button onClick={() => void submitRename()} disabled={renameSaving || !renameValue.trim()}>
              {t("workspace.menu.rename_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  width,
  active,
  closable,
  hasOthers,
  hasRight,
  dragging,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onEdit,
  onReveal,
  onDragStart,
  onDragEnd,
  onDragOverTab,
}: {
  containerKey: ContainerKey;
  workspace: WorkspaceDto | null;
  width: string;
  active: boolean;
  closable: boolean;
  hasOthers: boolean;
  hasRight: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onEdit?: () => void;
  onReveal?: () => void;
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
  // NewMax WorkspaceTab 原样移植:28px 高页签,激活态与下方面板(surface-200)连体——
  // 底部 3px 连接条 + 两侧 radial-gradient 反圆角(R=13),白色顶内衬制造受光面。
  const TAB_CORNER_R = 13;
  return (
    <ContextMenu>
      <Tooltip delayDuration={800}>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
    <button
      type="button"
      draggable
      ref={(node) => {
        // I3:激活标签滚入视野(超过容量收缩下限后靠横向滚动兜底)
        if (node && active) node.scrollIntoView({ inline: "nearest", block: "nearest" });
      }}
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
      style={{
        width,
        ...(active
          ? {
              filter: "drop-shadow(rgba(0, 0, 0, 0.08) 0px 0px 0.5px)",
              clipPath: "inset(-2px -15px -2px -15px)",
            }
          : undefined),
      }}
    >
      <div
        className={cn(
          "group relative flex h-7 w-full items-center gap-1.5 pl-2.5 pr-1.5 text-[0.8125rem] font-medium transition-colors duration-150",
          active
            ? "rounded-t-[10px] bg-[var(--ds-surface-200)] text-[var(--ds-text-primary)]"
            : "rounded-[10px] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
        )}
      >
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
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
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-[380px]">
          <div className="font-medium">{label}</div>
          {workspace ? (
            <div className="mt-0.5 font-normal break-all text-[var(--ds-text-secondary)]">
              {workspace.root}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="min-w-44">
        {workspace && onEdit ? (
          <>
            <ContextMenuItem onSelect={onEdit}>
              <Pencil className="size-4" strokeWidth={1.75} />
              {t("workspace.menu.rename")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem disabled={!closable} onSelect={onClose}>
          {t("workspace.tabs.ctx_close")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={onCloseOthers}>
          {t("workspace.tabs.ctx_close_others")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasRight} onSelect={onCloseRight}>
          {t("workspace.tabs.ctx_close_right")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCloseAll}>{t("workspace.tabs.ctx_close_all")}</ContextMenuItem>
        {workspace && onReveal ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onReveal}>
              <FolderOpen className="size-4" strokeWidth={1.75} />
              {t("workspace.menu.reveal")}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
