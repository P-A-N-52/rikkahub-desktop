import { create } from "zustand";

// ===== 双层标签页导航状态(工作区 M2-1) =====
// 一层标签 = 容器("chat" 固定键 = 对话模式;其余键 = workspaceId);
// 二层标签 = 各容器内已打开的会话。纯前端 UI 状态,localStorage 持久化——
// 服务端只关心 conversation.workspaceId 归属,"哪些标签开着"是本机偏好。
// 首启迁移即默认态:openTabs=["chat"],旧会话 workspaceId 全为 null,天然归入
// 对话模式容器,用户无感(方案 §3.1)。
//
// 不变量:openTabs 非空、无重复;activeTab ∈ openTabs。关闭 ≠ 删除:容器收起后
// 其二层标签状态保留,重开即恢复(工作区从"＋"菜单或侧栏历史重开)。

export const CHAT_CONTAINER = "chat";

export type ContainerKey = string;

interface ContainerTabsState {
  openTabs: ContainerKey[];
  activeTab: ContainerKey;
  /** 容器 → 已打开的会话标签(有序)。 */
  conversationTabs: Record<ContainerKey, string[]>;
  /** 容器 → 当前激活的会话(null = 该容器停在"新对话"态)。 */
  activeConversation: Record<ContainerKey, string | null>;

  activateContainer: (key: ContainerKey) => void;
  /** 打开并激活容器(已开则仅激活)。 */
  openContainer: (key: ContainerKey) => void;
  /** 收起容器标签。若关闭的是激活容器,激活其右邻(无则左邻);关到最后一个时回落到对话模式。 */
  closeContainer: (key: ContainerKey) => void;
  /** 批量收起容器标签(右键菜单):others=只留 anchor;right=关 anchor 右侧;all=全关(回落对话模式)。 */
  closeContainersBatch: (scope: "others" | "right" | "all", anchor: ContainerKey) => void;
  reorderContainer: (key: ContainerKey, toIndex: number) => void;

  /** 在容器内打开会话标签并激活(容器随之打开并激活)。路由是权威,本方法由路由同步调用。 */
  openConversation: (container: ContainerKey, conversationId: string) => void;
  /** 回到容器的"新对话"态(不动已开标签)。 */
  clearActiveConversation: (container: ContainerKey) => void;
  /** 关闭会话标签。返回该容器关闭后应激活的会话(undefined = 关闭的不是激活标签,无需导航)。 */
  closeConversation: (container: ContainerKey, conversationId: string) => string | null | undefined;
  /** 批量关闭会话标签(右键菜单)。返回容器关闭后应激活的会话(undefined = 激活标签未受影响)。 */
  closeConversationsBatch: (container: ContainerKey, scope: "others" | "right" | "all", anchor: string) => string | null | undefined;
  /** 会话被删除时从所有容器状态中移除。 */
  forgetConversation: (conversationId: string) => void;
  /** 工作区被删除后清理其容器标签与二层状态。 */
  pruneWorkspaces: (validWorkspaceIds: ReadonlySet<string>) => void;
}

const STORAGE_KEY = "rikkahub.container-tabs.v1";

interface PersistedShape {
  openTabs: ContainerKey[];
  activeTab: ContainerKey;
  conversationTabs: Record<ContainerKey, string[]>;
  activeConversation: Record<ContainerKey, string | null>;
}

function sanitize(raw: unknown): PersistedShape | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PersistedShape>;
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
  const conversationTabs: Record<string, string[]> = {};
  if (value.conversationTabs && typeof value.conversationTabs === "object") {
    for (const [key, ids] of Object.entries(value.conversationTabs)) {
      if (!Array.isArray(ids)) continue;
      conversationTabs[key] = [
        ...new Set(ids.filter((id): id is string => typeof id === "string")),
      ];
    }
  }
  const activeConversation: Record<string, string | null> = {};
  if (value.activeConversation && typeof value.activeConversation === "object") {
    for (const [key, id] of Object.entries(value.activeConversation)) {
      if (id === null || typeof id === "string") activeConversation[key] = id;
    }
  }
  return { openTabs, activeTab, conversationTabs, activeConversation };
}

function loadPersisted(): PersistedShape {
  const fallback: PersistedShape = {
    openTabs: [CHAT_CONTAINER],
    activeTab: CHAT_CONTAINER,
    conversationTabs: {},
    activeConversation: {},
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
      const tabs = state.conversationTabs[container] ?? [];
      return {
        openTabs: state.openTabs.includes(container)
          ? state.openTabs
          : [...state.openTabs, container],
        activeTab: container,
        conversationTabs: tabs.includes(conversationId)
          ? state.conversationTabs
          : { ...state.conversationTabs, [container]: [...tabs, conversationId] },
        activeConversation: { ...state.activeConversation, [container]: conversationId },
      };
    }),

  clearActiveConversation: (container) =>
    set((state) =>
      state.activeConversation[container] == null
        ? state
        : { activeConversation: { ...state.activeConversation, [container]: null } },
    ),

  closeConversation: (container, conversationId) => {
    const state = get();
    const tabs = state.conversationTabs[container] ?? [];
    const index = tabs.indexOf(conversationId);
    if (index < 0) return undefined;
    const nextTabs = tabs.filter((id) => id !== conversationId);
    const wasActive = state.activeConversation[container] === conversationId;
    const nextActive = wasActive
      ? (nextTabs[Math.min(index, nextTabs.length - 1)] ?? null)
      : undefined;
    set({
      conversationTabs: { ...state.conversationTabs, [container]: nextTabs },
      ...(wasActive
        ? { activeConversation: { ...state.activeConversation, [container]: nextActive ?? null } }
        : {}),
    });
    return nextActive;
  },

  closeConversationsBatch: (container, scope, anchor) => {
    const state = get();
    const tabs = state.conversationTabs[container] ?? [];
    const index = tabs.indexOf(anchor);
    if (index < 0) return undefined;
    const nextTabs =
      scope === "others" ? [anchor] : scope === "right" ? tabs.slice(0, index + 1) : [];
    const currentActive = state.activeConversation[container] ?? null;
    const activeStays = currentActive !== null && nextTabs.includes(currentActive);
    const nextActive = activeStays ? undefined : nextTabs.length > 0 ? anchor : null;
    set({
      conversationTabs: { ...state.conversationTabs, [container]: nextTabs },
      ...(nextActive !== undefined
        ? { activeConversation: { ...state.activeConversation, [container]: nextActive } }
        : {}),
    });
    return nextActive;
  },

  forgetConversation: (conversationId) =>
    set((state) => {
      let touched = false;
      const conversationTabs: Record<string, string[]> = {};
      for (const [key, ids] of Object.entries(state.conversationTabs)) {
        if (ids.includes(conversationId)) {
          touched = true;
          conversationTabs[key] = ids.filter((id) => id !== conversationId);
        } else {
          conversationTabs[key] = ids;
        }
      }
      const activeConversation = { ...state.activeConversation };
      for (const [key, id] of Object.entries(activeConversation)) {
        if (id === conversationId) {
          touched = true;
          activeConversation[key] = null;
        }
      }
      return touched ? { conversationTabs, activeConversation } : state;
    }),

  pruneWorkspaces: (validWorkspaceIds) =>
    set((state) => {
      const stale = state.openTabs.filter(
        (tab) => tab !== CHAT_CONTAINER && !validWorkspaceIds.has(tab),
      );
      const staleState =
        Object.keys(state.conversationTabs).some(
          (key) => key !== CHAT_CONTAINER && !validWorkspaceIds.has(key),
        ) ||
        Object.keys(state.activeConversation).some(
          (key) => key !== CHAT_CONTAINER && !validWorkspaceIds.has(key),
        );
      if (stale.length === 0 && !staleState) return state;
      const openTabs = state.openTabs.filter((tab) => !stale.includes(tab));
      const keep = (key: string) => key === CHAT_CONTAINER || validWorkspaceIds.has(key);
      const conversationTabs = Object.fromEntries(
        Object.entries(state.conversationTabs).filter(([key]) => keep(key)),
      );
      const activeConversation = Object.fromEntries(
        Object.entries(state.activeConversation).filter(([key]) => keep(key)),
      );
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          activeTab: CHAT_CONTAINER,
          conversationTabs,
          activeConversation,
        };
      }
      return {
        openTabs,
        activeTab: openTabs.includes(state.activeTab) ? state.activeTab : openTabs[0]!,
        conversationTabs,
        activeConversation,
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
          conversationTabs: state.conversationTabs,
          activeConversation: state.activeConversation,
        } satisfies PersistedShape),
      );
    } catch {
      /* 配额/隐私模式:标签状态退化为会话级 */
    }
  });
}
