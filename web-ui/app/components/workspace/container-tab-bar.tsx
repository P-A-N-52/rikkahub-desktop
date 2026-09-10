import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  Folder,
  FolderOpen,
  FolderSearch,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Pencil,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  CreateFolderWorkspaceDialog,
  WorkspaceTrustDialog,
} from "~/components/workspace/workspace-create-dialogs";
import api from "~/services/api";
import {
  CHAT_CONTAINER,
  MAX_PANES,
  useContainerTabsStore,
  type ContainerKey,
} from "~/stores/container-tabs-store";
import { useTabDragStore } from "~/stores/tab-drag-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 一层容器标签栏(工作区 M2-1;前端重构A1 复刻 NewMax 浏览器式页签):
// 组焦点标签白底上圆角,与下方组内容面板连成一体;同组的非焦点标签为该组面板色
// 胶囊(淡一个层级);不在任何组的标签是画布上的幽灵态。中键/×关闭(仅收起);
// 拖拽排序;Ctrl+Tab 循环;溢出横滚。
// K 轮组模型:每个组分栏各挂一条本组件(container = 该组焦点容器),标签栏只高亮
// 自己组的成员 —— 与二级分栏"每列一条会话标签栏"同构。新建入口只在全局焦点组
// (activeTab 所在组)的条上渲染,其余组收到 null。
// 拖拽:在标签上悬停 = 组内重排;落进组的空白处 = 并入该组;落到组内容区边缘 =
// 拆出新组(落点区在 conversations.tsx)。

/** 点击/循环切换容器:激活并导航到该容器上次停留的会话(无则回"新对话"首页)。 */
function navigateToContainer(key: ContainerKey, navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  store.activateContainer(key);
  // 容器的"上次停留会话" = 聚焦窗格的激活会话。
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

/** 组焦点容器被并入邻组(或换成别的容器)后,把路由/会话选择交还给全局焦点列。 */
function navigateToActiveContainer(navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  const key = store.activeTab;
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

/** 把 key 移到 anchor 的左/右侧(anchor 不在列表内则原样返回拷贝)。 */
function moveBeside(
  list: readonly ContainerKey[],
  key: ContainerKey,
  anchor: ContainerKey,
  side: "left" | "right",
): ContainerKey[] {
  const rest = list.filter((item) => item !== key);
  const at = rest.indexOf(anchor);
  if (at < 0) return [...list];
  rest.splice(side === "left" ? at : at + 1, 0, key);
  return rest;
}

export function ContainerTabBar({
  container,
  headerTrailing = null,
}: {
  /** 本标签栏所属组的焦点容器(组模型:每组分栏一条标签栏)。 */
  container: ContainerKey;
  /** 行尾动作位(全局焦点组挂"新建"入口,其余组为 null)。 */
  headerTrailing?: React.ReactNode;
}) {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const openTabs = useContainerTabsStore((state) => state.openTabs);
  const groups = useContainerTabsStore((state) => state.groups);
  const groupIndex = groups.indexOf(container);
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

  // G4 右键菜单批量关闭:store 更新后按新 activeTab 导航(可能落回原容器,导航幂等)。
  const closeTabsBatch = React.useCallback(
    (scope: "others" | "right" | "all", anchor: ContainerKey) => {
      useContainerTabsStore.getState().closeContainersBatch(scope, anchor);
      navigateToContainer(useContainerTabsStore.getState().activeTab, navigate);
    },
    [navigate],
  );

  // K 轮组模型:把容器拆到本组左/右侧成新组(右键菜单入口;拖拽入口在内容区落点区)。
  // 已在屏上的容器先脱离原位再落位(横移);拒绝 = 可见列已满,给出可行动提示。
  const splitContainerBeside = React.useCallback(
    (key: ContainerKey, side: "left" | "right") => {
      const store = useContainerTabsStore.getState();
      if (key === container) return;
      store.mergeContainer(key); // 已在屏上 → 先脱离原组,再落到目标侧
      if (!store.splitContainerBeside(key, container, side)) {
        toast.error(t("workspace.tabs.split_full", { max: MAX_PANES }));
        return;
      }
      navigateToContainer(key, navigate);
    },
    [container, navigate, t],
  );

  // 合并:容器退出分栏、回到标签栏里,由邻组接管显示(标签不关、二层状态保留)。
  const mergeContainerTab = React.useCallback(
    (key: ContainerKey) => {
      if (useContainerTabsStore.getState().mergeContainer(key)) {
        navigateToActiveContainer(navigate);
      }
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
      <div
        className="flex h-full min-w-0 items-end gap-[3px] overflow-x-auto pl-[13px] [scrollbar-width:none]"
        onDragOver={(event) => {
          // 落进本组空白处 = 并入本组(组焦点换成它);等效于点标签,只是顺手一放。
          // 标签自身的 onDragOver 处理组内重排,已 stopPropagation 不会走到这里。
          const dragging = useTabDragStore.getState().dragging;
          if (dragging?.kind === "container" && dragging.container !== container) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          const dragging = useTabDragStore.getState().dragging;
          if (dragging?.kind !== "container" || dragging.container === container) return;
          event.preventDefault();
          useTabDragStore.getState().setDragging(null);
          setDragKey(null);
          navigateToContainer(dragging.container, navigate);
        }}
      >
        {openTabs.map((key, index) => (
          <ContainerTab
            key={key}
            containerKey={key}
            workspace={key === CHAT_CONTAINER ? null : (workspaceById.get(key) ?? null)}
            width={tabWidthCalc}
            active={key === container}
            /** 本组的非焦点标签:组面板色胶囊(它的列也在屏上),弱于焦点态。 */
            inGroup={key !== container && groupIndex >= 0 && groups[groupIndex] === key}
            closable={openTabs.length > 1}
            hasOthers={openTabs.length > 1}
            hasRight={index < openTabs.length - 1}
            splitable={key !== container}
            unsplitable={groupIndex >= 0 && groups[groupIndex] === key && groups.length > 1}
            dragging={dragKey === key}
            onActivate={() => activateGuarded(key)}
            onClose={() => closeTab(key)}
            onCloseOthers={() => closeTabsBatch("others", key)}
            onCloseRight={() => closeTabsBatch("right", key)}
            onCloseAll={() => closeTabsBatch("all", key)}
            onSplitRight={() => splitContainerBeside(key, "right")}
            onSplitLeft={() => splitContainerBeside(key, "left")}
            onUnsplit={() => mergeContainerTab(key)}
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
            onDragStart={() => {
              setDragKey(key);
              // 载荷入内存 store(dataTransfer 在 dragover 阶段读不到):落到组内容区
              // 边缘 = 拆新组;落到组标签栏空白处 = 并入该组(见 conversations.tsx)。
              useTabDragStore.getState().setDragging({ kind: "container", container: key });
            }}
            onDragEnd={() => {
              setDragKey(null);
              useTabDragStore.getState().setDragging(null);
            }}
            onDragOverTab={(event) => {
              // 组内重排只在本组成员间发生;事件就地消化,不冒泡成"并入本组"。
              if (groupIndex < 0) return;
              const member = groups[groupIndex]!;
              if (!dragKey || dragKey === key || dragKey === container || dragKey === member) {
                return;
              }
              event.stopPropagation();
              const to = moveBeside(openTabs, dragKey, member, index > groupIndex ? "right" : "left");
              useContainerTabsStore.getState().setOpenTabsOrder(to);
            }}
          />
        ))}
      </div>

      {headerTrailing}

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
              <label className="text-compact font-medium text-[var(--ds-text-secondary)]">
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
              <label className="text-compact font-medium text-[var(--ds-text-secondary)]">
                {t("workspace.menu.path_label")}
              </label>
              {renameTarget?.type === "folder" ? (
                <>
                  {/* B6-①b:folder 型路径可重绑。missing 态显示失效警告;改路径后提示需重新授权信任。 */}
                  {renameTarget.status === "missing" ? (
                    <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] bg-warning/10 px-3 py-2 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
                      <span>{t("workspace.menu.missing_hint")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Input
                      value={renameRoot}
                      onChange={(event) => setRenameRoot(event.target.value)}
                      placeholder={t("workspace.create.folder_path_placeholder")}
                      className="flex-1 font-mono text-compact"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void browseRenameRoot()}>
                      <FolderSearch className="mr-1 size-4" />
                      {t("workspace.create.browse")}
                    </Button>
                  </div>
                  {renameRoot.trim() && renameRoot.trim() !== renameTarget.root ? (
                    <div className="text-xs text-muted-foreground">{t("workspace.menu.rebind_notice")}</div>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => renameTarget && revealWorkspace(renameTarget)}
                  aria-label={t("workspace.menu.reveal")}
                  className="flex h-9 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-input)] px-3 text-left text-compact text-[var(--ds-text-secondary)] shadow-[var(--ds-input-shadow)] transition-shadow hover:shadow-[var(--ds-input-shadow-hover)]"
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
  inGroup,
  closable,
  hasOthers,
  hasRight,
  splitable,
  unsplitable,
  dragging,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onSplitLeft,
  onSplitRight,
  onUnsplit,
  onEdit,
  onReveal,
  onDragStart,
  onDragEnd,
  onDragOverTab,
}: {
  containerKey: ContainerKey;
  workspace: WorkspaceDto | null;
  width: string;
  /** 本组的焦点标签:与组内容面板连体。 */
  active: boolean;
  /** 本组的非焦点标签:组面板色胶囊,弱于焦点态。 */
  inGroup: boolean;
  closable: boolean;
  hasOthers: boolean;
  hasRight: boolean;
  splitable: boolean;
  unsplitable: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onSplitLeft: () => void;
  onSplitRight: () => void;
  onUnsplit: () => void;
  onEdit?: () => void;
  onReveal?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTab: (event: React.DragEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation("page");
  const isChat = containerKey === CHAT_CONTAINER;
  const label = isChat
    ? t("workspace.tabs.chat")
    : (workspace?.name ?? t("workspace.tabs.missing"));
  const Icon = isChat ? MessageSquare : workspace?.type === "folder" ? FolderOpen : Folder;
  // NewMax WorkspaceTab 原样移植:28px 高页签,焦点标签与下方组面板(surface-200)连体——
  // 底部 3px 连接条 + 两侧 radial-gradient 反圆角(R=13),白色顶内衬制造受光面。
  // 组模型的三态:连体(本组焦点)> 面板色胶囊(本组成员,它的列也在屏上)> 幽灵。
  // 连体造型每组只有一份,且组焦点标签恒为本组首枚,其左侧必是本组面板的左缘——
  // 反圆角溢出的 13px 永远落在自己组的面板上,不会渗进别组的幽灵标签底下。
  const TAB_CORNER_R = 13;
  const docked = inGroup;
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
        onDragOverTab(event);
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
          "group relative flex h-7 w-full items-center gap-1.5 pl-2.5 pr-1.5 text-compact font-medium transition-colors duration-150",
          active
            ? "rounded-t-[10px] bg-[var(--ds-surface-200)] text-[var(--ds-text-primary)]"
            : docked
              ? "rounded-[10px] bg-[var(--ds-surface-200)] text-[var(--ds-text-secondary)] shadow-[var(--ds-elevation-100)]"
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
        {/* K 轮组模型:键鼠/无障碍等价路径(拖拽是主交互,但不能是唯一交互)。
            "分栏到左/右" 以本组焦点容器为锚点;本标签是组焦点时改为"合并回标签栏"。 */}
        {unsplitable ? (
          <ContextMenuItem onSelect={onUnsplit}>
            <Columns2 className="size-4" strokeWidth={1.75} />
            {t("workspace.tabs.ctx_unsplit")}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem disabled={!splitable} onSelect={onSplitLeft}>
              <PanelLeft className="size-4" strokeWidth={1.75} />
              {t("workspace.tabs.ctx_split_left")}
            </ContextMenuItem>
            <ContextMenuItem disabled={!splitable} onSelect={onSplitRight}>
              <PanelRight className="size-4" strokeWidth={1.75} />
              {t("workspace.tabs.ctx_split_right")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
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
