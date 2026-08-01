import { create } from "zustand";

// ===== 双层标签页导航状态(工作区 M2-1;J 轮升级窗格分栏) =====
// 一层标签 = 容器("chat" 固定键 = 对话模式;其余键 = workspaceId);
// 二层标签 = 各容器内已打开的会话,J 轮起按"窗格"分组:每容器 1..MAX_PANES 个窗格
// 左右并排(NewMax 双栏对位,我们支持到三栏),每个窗格有自己的标签组与激活会话。
// 纯前端 UI 状态,localStorage 持久化——服务端只关心 conversation.workspaceId 归属。
//
// 不变量:
// - openTabs 非空、无重复;activeTab ∈ openTabs。
// - 每容器窗格数 1..MAX_PANES;同一会话在一个容器内只出现一次(跨窗格去重);
//   空窗格只允许在窗格数为 1 时存在(多窗格下最后一个标签关闭即收起该窗格)。
// - focusedPane ∈ [0, panes.length)。路由 /c/:id 跟随聚焦窗格的激活会话。
// 关闭 ≠ 删除:容器收起后其二层状态保留,重开即恢复。

export const CHAT_CONTAINER = "chat";

/** 每容器最多窗格数:双栏是常规交互,三栏留给宽屏(超过则拒绝分栏)。 */
export const MAX_PANES = 3;

export type ContainerKey = string;

export interface ConversationPane {
  tabs: string[];
  active: string | null;
}

interface ContainerTabsState {
  openTabs: ContainerKey[];
  activeTab: ContainerKey;
  /** 容器 → 窗格数组(有序,左→右)。缺省视作单个空窗格。 */
  panes: Record<ContainerKey, ConversationPane[]>;
  /** 容器 → 聚焦窗格下标(路由/侧栏/快捷键跟随聚焦窗格)。 */
  focusedPane: Record<ContainerKey, number>;

  activateContainer: (key: ContainerKey) => void;
  /** 打开并激活容器(已开则仅激活)。 */
  openContainer: (key: ContainerKey) => void;
  /** 收起容器标签。若关闭的是激活容器,激活其右邻(无则左邻);关到最后一个时回落到对话模式。 */
  closeContainer: (key: ContainerKey) => void;
  /** 批量收起容器标签(右键菜单):others=只留 anchor;right=关 anchor 右侧;all=全关(回落对话模式)。 */
  closeContainersBatch: (scope: "others" | "right" | "all", anchor: ContainerKey) => void;
  reorderContainer: (key: ContainerKey, toIndex: number) => void;

  /** 在容器内打开会话标签并激活(容器随之打开并激活)。已在其他窗格打开则聚焦过去。
      路由是权威,本方法由路由同步调用。 */
  openConversation: (container: ContainerKey, conversationId: string) => void;
  /** 聚焦窗格回到"新对话"态(不动已开标签)。 */
  clearActiveConversation: (container: ContainerKey) => void;
  /** 聚焦指定窗格。返回该窗格的激活会话(便于调用方导航)。 */
  focusPane: (container: ContainerKey, index: number) => string | null;
  /** 关闭会话标签(自动定位所在窗格;多窗格下窗格随最后一个标签关闭而收起)。
      返回聚焦窗格随之应激活的会话(undefined = 聚焦窗格的激活标签未受影响,无需导航)。 */
  closeConversation: (container: ContainerKey, conversationId: string) => string | null | undefined;
  /** 批量关闭会话标签(右键菜单,作用于 anchor 所在窗格)。返回语义同 closeConversation。 */
  closeConversationsBatch: (container: ContainerKey, scope: "others" | "right" | "all", anchor: string) => string | null | undefined;
  /** J 轮分栏:把会话标签拖出为新窗格(插入到 toIndex 位置)并聚焦。
      源窗格只剩它一个标签、或已达 MAX_PANES 时拒绝。返回是否成功。 */
  splitConversation: (container: ContainerKey, conversationId: string, toIndex: number) => boolean;
  /** J 轮跨栏移动:把会话标签移入既有窗格尾部并激活聚焦;源窗格空了即收起。 */
  moveConversationToPane: (container: ContainerKey, conversationId: string, toPane: number) => void;
  /** 会话被删除时从所有容器所有窗格中移除。 */
  forgetConversation: (conversationId: string) => void;
  /** 工作区被删除后清理其容器标签与二层状态。 */
  pruneWorkspaces: (validWorkspaceIds: ReadonlySet<string>) => void;
}

const STORAGE_KEY = "rikkahub.container-tabs.v1";

interface PersistedShape {
  openTabs: ContainerKey[];
  activeTab: ContainerKey;
  panes: Record<ContainerKey, ConversationPane[]>;
  focusedPane: Record<ContainerKey, number>;
}

const emptyPane = (): ConversationPane => ({ tabs: [], active: null });

/** 读取容器窗格(缺省单个空窗格)。返回值仅供读取,写入前须拷贝。 */
function panesOf(state: Pick<ContainerTabsState, "panes">, container: ContainerKey): ConversationPane[] {
  const panes = state.panes[container];
  return panes && panes.length > 0 ? panes : [emptyPane()];
}

function clampFocus(state: Pick<ContainerTabsState, "focusedPane">, container: ContainerKey, paneCount: number): number {
  const idx = state.focusedPane[container] ?? 0;
  return Math.max(0, Math.min(idx, paneCount - 1));
}

function sanitizePane(raw: unknown): ConversationPane | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ConversationPane>;
  const tabs = Array.isArray(value.tabs)
    ? [...new Set(value.tabs.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  const active = typeof value.active === "string" && tabs.includes(value.active) ? value.active : null;
  return { tabs, active };
}

function sanitize(raw: unknown): PersistedShape | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const openTabs = Array.isArray(value.openTabs)
    ? [
        ...new Set(
          value.openTabs.filter((tab): tab is string => typeof tab === "string" && tab.length > 0),
        ),
      ]
    : [];
  if (openTabs.length === 0) return null;
  const activeTab =
    typeof value.activeTab === "string" && openTabs.includes(value.activeTab)
      ? value.activeTab
      : openTabs[0]!;

  const panes: Record<string, ConversationPane[]> = {};
  const focusedPane: Record<string, number> = {};

  if (value.panes && typeof value.panes === "object") {
    // v2 形状(J 轮):窗格数组直存。
    for (const [key, rawPanes] of Object.entries(value.panes as Record<string, unknown>)) {
      if (!Array.isArray(rawPanes)) continue;
      const seen = new Set<string>();
      const list: ConversationPane[] = [];
      for (const rawPane of rawPanes.slice(0, MAX_PANES)) {
        const pane = sanitizePane(rawPane);
        if (!pane) continue;
        // 跨窗格去重:同一会话只保留首个出现的窗格。
        const tabs = pane.tabs.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
        const active = pane.active !== null && tabs.includes(pane.active) ? pane.active : (tabs[0] ?? null);
        list.push({ tabs, active });
      }
      // 多窗格下剔除空窗格(不变量);全空则回落单空窗格。
      const nonEmpty = list.filter((pane) => pane.tabs.length > 0);
      panes[key] = nonEmpty.length > 0 ? nonEmpty : [list[0] ?? emptyPane()];
    }
    if (value.focusedPane && typeof value.focusedPane === "object") {
      for (const [key, idx] of Object.entries(value.focusedPane as Record<string, unknown>)) {
        if (typeof idx === "number" && Number.isInteger(idx)) {
          focusedPane[key] = Math.max(0, Math.min(idx, (panes[key]?.length ?? 1) - 1));
        }
      }
    }
  } else if (value.conversationTabs && typeof value.conversationTabs === "object") {
    // v1 迁移:单标签组 → 单窗格。
    const activeConversation =
      value.activeConversation && typeof value.activeConversation === "object"
        ? (value.activeConversation as Record<string, unknown>)
        : {};
    for (const [key, ids] of Object.entries(value.conversationTabs as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const tabs = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
      const rawActive = activeConversation[key];
      const active = typeof rawActive === "string" && tabs.includes(rawActive) ? rawActive : null;
      panes[key] = [{ tabs, active }];
    }
  }

  return { openTabs, activeTab, panes, focusedPane };
}

function loadPersisted(): PersistedShape {
  const fallback: PersistedShape = {
    openTabs: [CHAT_CONTAINER],
    activeTab: CHAT_CONTAINER,
    panes: {},
    focusedPane: {},
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")) ?? fallback;
  } catch {
    return fallback;
  }
}

export const useContainerTabsStore = create<ContainerTabsState>((set, get) => ({
  ...loadPersisted(),

  activateContainer: (key) =>
    set((state) =>
      state.openTabs.includes(key) && state.activeTab !== key ? { activeTab: key } : state,
    ),

  openContainer: (key) =>
    set((state) => ({
      openTabs: state.openTabs.includes(key) ? state.openTabs : [...state.openTabs, key],
      activeTab: key,
    })),

  closeContainer: (key) =>
    set((state) => {
      const index = state.openTabs.indexOf(key);
      if (index < 0) return state;
      const openTabs = state.openTabs.filter((tab) => tab !== key);
      if (openTabs.length === 0) {
        return { openTabs: [CHAT_CONTAINER], activeTab: CHAT_CONTAINER };
      }
      const activeTab =
        state.activeTab === key
          ? (openTabs[Math.min(index, openTabs.length - 1)] ?? openTabs[0]!)
          : state.activeTab;
      return { openTabs, activeTab };
    }),

  closeContainersBatch: (scope, anchor) =>
    set((state) => {
      const index = state.openTabs.indexOf(anchor);
      if (index < 0) return state;
      const openTabs =
        scope === "others"
          ? [anchor]
          : scope === "right"
            ? state.openTabs.slice(0, index + 1)
            : [];
      if (openTabs.length === 0) {
        return { openTabs: [CHAT_CONTAINER], activeTab: CHAT_CONTAINER };
      }
      const activeTab = openTabs.includes(state.activeTab) ? state.activeTab : anchor;
      return { openTabs, activeTab };
    }),

  reorderContainer: (key, toIndex) =>
    set((state) => {
      const from = state.openTabs.indexOf(key);
      if (from < 0) return state;
      const clamped = Math.max(0, Math.min(toIndex, state.openTabs.length - 1));
      if (clamped === from) return state;
      const openTabs = [...state.openTabs];
      openTabs.splice(from, 1);
      openTabs.splice(clamped, 0, key);
      return { openTabs };
    }),

  openConversation: (container, conversationId) =>
    set((state) => {
      const panes = panesOf(state, container).map((pane) => ({ ...pane, tabs: [...pane.tabs] }));
      let focus = clampFocus(state, container, panes.length);
      const existing = panes.findIndex((pane) => pane.tabs.includes(conversationId));
      if (existing >= 0) {
        // 已在某窗格打开:聚焦该窗格并激活,不建重复标签。
        focus = existing;
        panes[existing]!.active = conversationId;
      } else {
        const target = panes[focus]!;
        target.tabs.push(conversationId);
        target.active = conversationId;
      }
      return {
        openTabs: state.openTabs.includes(container)
          ? state.openTabs
          : [...state.openTabs, container],
        activeTab: container,
        panes: { ...state.panes, [container]: panes },
        focusedPane: { ...state.focusedPane, [container]: focus },
      };
    }),

  clearActiveConversation: (container) =>
    set((state) => {
      const panes = panesOf(state, container);
      const focus = clampFocus(state, container, panes.length);
      if (panes[focus]!.active == null) return state;
      const next = panes.map((pane, i) => (i === focus ? { ...pane, active: null } : pane));
      return { panes: { ...state.panes, [container]: next } };
    }),

  focusPane: (container, index) => {
    const state = get();
    const panes = panesOf(state, container);
    const clamped = Math.max(0, Math.min(index, panes.length - 1));
    if ((state.focusedPane[container] ?? 0) !== clamped) {
      set({ focusedPane: { ...state.focusedPane, [container]: clamped } });
    }
    return panes[clamped]!.active;
  },

  closeConversation: (container, conversationId) => {
    const state = get();
    const panes = panesOf(state, container);
    const paneIdx = panes.findIndex((pane) => pane.tabs.includes(conversationId));
    if (paneIdx < 0) return undefined;
    const focused = clampFocus(state, container, panes.length);
    const pane = panes[paneIdx]!;
    const tabIdx = pane.tabs.indexOf(conversationId);
    const nextTabs = pane.tabs.filter((id) => id !== conversationId);
    const wasActive = pane.active === conversationId;

    if (nextTabs.length === 0 && panes.length > 1) {
      // 多窗格下最后一个标签关闭 → 窗格收起。
      const nextPanes = panes.filter((_, i) => i !== paneIdx);
      const nextFocus =
        focused === paneIdx
          ? Math.min(paneIdx, nextPanes.length - 1)
          : focused > paneIdx
            ? focused - 1
            : focused;
      set({
        panes: { ...state.panes, [container]: nextPanes },
        focusedPane: { ...state.focusedPane, [container]: nextFocus },
      });
      return focused === paneIdx ? (nextPanes[nextFocus]!.active ?? null) : undefined;
    }

    const nextActive = wasActive
      ? (nextTabs[Math.min(tabIdx, nextTabs.length - 1)] ?? null)
      : pane.active;
    const nextPanes = panes.map((p, i) => (i === paneIdx ? { tabs: nextTabs, active: nextActive } : p));
    set({ panes: { ...state.panes, [container]: nextPanes } });
    // 非聚焦窗格内部的激活变化无需导航(路由跟随聚焦窗格)。
    return wasActive && paneIdx === focused ? nextActive : undefined;
  },

  closeConversationsBatch: (container, scope, anchor) => {
    const state = get();
    const panes = panesOf(state, container);
    const paneIdx = panes.findIndex((pane) => pane.tabs.includes(anchor));
    if (paneIdx < 0) return undefined;
    const focused = clampFocus(state, container, panes.length);
    const pane = panes[paneIdx]!;
    const index = pane.tabs.indexOf(anchor);
    const nextTabs =
      scope === "others" ? [anchor] : scope === "right" ? pane.tabs.slice(0, index + 1) : [];

    if (nextTabs.length === 0 && panes.length > 1) {
      const nextPanes = panes.filter((_, i) => i !== paneIdx);
      const nextFocus =
        focused === paneIdx
          ? Math.min(paneIdx, nextPanes.length - 1)
          : focused > paneIdx
            ? focused - 1
            : focused;
      set({
        panes: { ...state.panes, [container]: nextPanes },
        focusedPane: { ...state.focusedPane, [container]: nextFocus },
      });
      return focused === paneIdx ? (nextPanes[nextFocus]!.active ?? null) : undefined;
    }

    const activeStays = pane.active !== null && nextTabs.includes(pane.active);
    const nextActive = activeStays ? pane.active : nextTabs.length > 0 ? anchor : null;
    const nextPanes = panes.map((p, i) => (i === paneIdx ? { tabs: nextTabs, active: nextActive } : p));
    set({ panes: { ...state.panes, [container]: nextPanes } });
    return !activeStays && paneIdx === focused ? nextActive : undefined;
  },

  splitConversation: (container, conversationId, toIndex) => {
    const state = get();
    const panes = panesOf(state, container);
    if (panes.length >= MAX_PANES) return false;
    const fromIdx = panes.findIndex((pane) => pane.tabs.includes(conversationId));
    if (fromIdx < 0) return false;
    const from = panes[fromIdx]!;
    // 源窗格只剩这一个标签:移出即空(多窗格下空窗格立即收起),分栏无意义。
    if (from.tabs.length <= 1) return false;
    const tabPos = from.tabs.indexOf(conversationId);
    const fromTabs = from.tabs.filter((id) => id !== conversationId);
    const fromActive =
      from.active === conversationId
        ? (fromTabs[Math.min(tabPos, fromTabs.length - 1)] ?? null)
        : from.active;
    const nextPanes = panes.map((p, i) => (i === fromIdx ? { tabs: fromTabs, active: fromActive } : p));
    const insertAt = Math.max(0, Math.min(toIndex, nextPanes.length));
    nextPanes.splice(insertAt, 0, { tabs: [conversationId], active: conversationId });
    set({
      panes: { ...state.panes, [container]: nextPanes },
      focusedPane: { ...state.focusedPane, [container]: insertAt },
    });
    return true;
  },

  moveConversationToPane: (container, conversationId, toPane) => {
    const state = get();
    const panes = panesOf(state, container);
    const fromIdx = panes.findIndex((pane) => pane.tabs.includes(conversationId));
    const target = Math.max(0, Math.min(toPane, panes.length - 1));
    if (fromIdx < 0) return;
    if (fromIdx === target) {
      // 同窗格:只激活聚焦。
      const nextPanes = panes.map((p, i) => (i === fromIdx ? { ...p, active: conversationId } : p));
      set({
        panes: { ...state.panes, [container]: nextPanes },
        focusedPane: { ...state.focusedPane, [container]: fromIdx },
      });
      return;
    }
    const from = panes[fromIdx]!;
    const tabPos = from.tabs.indexOf(conversationId);
    const fromTabs = from.tabs.filter((id) => id !== conversationId);
    const fromActive =
      from.active === conversationId
        ? (fromTabs[Math.min(tabPos, fromTabs.length - 1)] ?? null)
        : from.active;
    let nextPanes = panes.map((p, i) => {
      if (i === fromIdx) return { tabs: fromTabs, active: fromActive };
      if (i === target) return { tabs: [...p.tabs, conversationId], active: conversationId };
      return p;
    });
    let nextFocus = target;
    if (fromTabs.length === 0) {
      // 源窗格空了即收起。
      nextPanes = nextPanes.filter((_, i) => i !== fromIdx);
      if (fromIdx < target) nextFocus = target - 1;
    }
    set({
      panes: { ...state.panes, [container]: nextPanes },
      focusedPane: { ...state.focusedPane, [container]: nextFocus },
    });
  },

  forgetConversation: (conversationId) =>
    set((state) => {
      let touched = false;
      const panesRecord: Record<string, ConversationPane[]> = {};
      const focusedPane = { ...state.focusedPane };
      for (const [key, panes] of Object.entries(state.panes)) {
        const hit = panes.some((pane) => pane.tabs.includes(conversationId));
        if (!hit) {
          panesRecord[key] = panes;
          continue;
        }
        touched = true;
        let next = panes.map((pane) => {
          if (!pane.tabs.includes(conversationId)) return pane;
          const tabIdx = pane.tabs.indexOf(conversationId);
          const tabs = pane.tabs.filter((id) => id !== conversationId);
          const active =
            pane.active === conversationId
              ? (tabs[Math.min(tabIdx, tabs.length - 1)] ?? null)
              : pane.active;
          return { tabs, active };
        });
        if (next.length > 1) {
          // 多窗格不变量:空窗格收起;全空回落单空窗格。
          const nonEmpty = next.filter((pane) => pane.tabs.length > 0);
          next = nonEmpty.length > 0 ? nonEmpty : [emptyPane()];
          const focusedIdx = clampFocus(state, key, panes.length);
          focusedPane[key] = Math.max(0, Math.min(focusedIdx, next.length - 1));
        }
        panesRecord[key] = next;
      }
      return touched ? { panes: panesRecord, focusedPane } : state;
    }),

  pruneWorkspaces: (validWorkspaceIds) =>
    set((state) => {
      const stale = state.openTabs.filter(
        (tab) => tab !== CHAT_CONTAINER && !validWorkspaceIds.has(tab),
      );
      const keep = (key: string) => key === CHAT_CONTAINER || validWorkspaceIds.has(key);
      const staleState =
        Object.keys(state.panes).some((key) => !keep(key)) ||
        Object.keys(state.focusedPane).some((key) => !keep(key));
      if (stale.length === 0 && !staleState) return state;
      const openTabs = state.openTabs.filter((tab) => !stale.includes(tab));
      const panes = Object.fromEntries(Object.entries(state.panes).filter(([key]) => keep(key)));
      const focusedPane = Object.fromEntries(
        Object.entries(state.focusedPane).filter(([key]) => keep(key)),
      );
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          activeTab: CHAT_CONTAINER,
          panes,
          focusedPane,
        };
      }
      return {
        openTabs,
        activeTab: openTabs.includes(state.activeTab) ? state.activeTab : openTabs[0]!,
        panes,
        focusedPane,
      };
    }),
}));

if (typeof localStorage !== "undefined") {
  useContainerTabsStore.subscribe((state) => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openTabs: state.openTabs,
          activeTab: state.activeTab,
          panes: state.panes,
          focusedPane: state.focusedPane,
        } satisfies PersistedShape),
      );
    } catch {
      /* 配额/隐私模式:标签状态退化为会话级 */
    }
  });
}
