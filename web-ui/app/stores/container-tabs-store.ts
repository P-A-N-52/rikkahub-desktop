import { create } from "zustand";

// ===== 双层标签页导航状态(工作区 M2-1;J 轮窗格分栏;K 轮一级容器并排) =====
// 一层标签 = 容器("chat" 固定键 = 对话模式;其余键 = workspaceId);
// 二层标签 = 各容器内已打开的会话,按"窗格"分组:每容器有自己的窗格组与激活会话。
// K 轮起一级容器自身也能并排:layout = 当前左右并排显示的容器(有序),每个容器
// "带着"自己的窗格组整块出现——屏幕上的列 = Σ 各并排容器的窗格数,与二层分栏共用
// 同一个 MAX_PANES 上限。单容器时退化为 J 轮的纯二层分栏,行为逐字不变。
// 纯前端 UI 状态,localStorage 持久化——服务端只关心 conversation.workspaceId 归属。
//
// 不变量:
// - openTabs 非空、无重复;layout 非空、无重复、⊆ openTabs,且次序恒与 openTabs 一致
//   (单一排序源:一级标签的左右次序就是列的左右次序,不存在两套次序打架);
//   activeTab ∈ layout —— 聚焦列所属容器,即路由 /c/:id、侧栏、热键的作用域。
// - 可见总列数 Σ|panes[c]|(c ∈ layout)≤ MAX_PANES。
// - 每容器窗格数 1..MAX_PANES;同一会话在一个容器内只出现一次(跨窗格去重);
//   空窗格只允许在该容器窗格数为 1 时存在(多窗格下最后一个标签关闭即收起该窗格)。
// - focusedPane[c] ∈ [0, |panes[c]|)。
// 关闭 ≠ 删除:容器收起(或仅移出并排)后其二层状态保留,重开即恢复。

export const CHAT_CONTAINER = "chat";

/** 可见列数上限(= Σ 并排容器的窗格数):双栏是常规交互,三栏留给宽屏。 */
export const MAX_PANES = 3;

export type ContainerKey = string;

export interface ConversationPane {
  tabs: string[];
  active: string | null;
}

/** 屏幕上的一列:某容器的某个窗格。列的左右顺序 = layout 顺序 × 容器内窗格顺序。 */
export interface PaneColumn {
  container: ContainerKey;
  /** 容器内窗格下标(不是全局列号)——所有 store 方法都按容器内下标寻址。 */
  paneIndex: number;
  pane: ConversationPane;
}

interface ContainerTabsState {
  openTabs: ContainerKey[];
  /** 并排显示的容器(左→右;顺序由 openTabs 派生)。 */
  layout: ContainerKey[];
  /** 聚焦列所属容器。 */
  activeTab: ContainerKey;
  /** 容器 → 窗格数组(有序,左→右)。缺省视作单个空窗格。 */
  panes: Record<ContainerKey, ConversationPane[]>;
  /** 容器 → 聚焦窗格下标(路由/侧栏/快捷键跟随聚焦列)。 */
  focusedPane: Record<ContainerKey, number>;

  activateContainer: (key: ContainerKey) => void;
  /** 打开并激活容器(已开则仅激活;未在并排布局中则占用当前焦点列)。 */
  openContainer: (key: ContainerKey) => void;
  /** 收起容器标签。若关闭的是激活容器,激活其右邻(无则左邻);关到最后一个时回落到对话模式。 */
  closeContainer: (key: ContainerKey) => void;
  /** 批量收起容器标签(右键菜单):others=只留 anchor;right=关 anchor 右侧;all=全关(回落对话模式)。 */
  closeContainersBatch: (scope: "others" | "right" | "all", anchor: ContainerKey) => void;
  reorderContainer: (key: ContainerKey, toIndex: number) => void;

  /** K 轮一级并排:把容器并排到 anchor 容器的左/右侧并聚焦。可见列超上限、
      容器未打开、anchor 不在并排中时拒绝;已在并排中则仅调整左右位置。
      返回是否成功。 */
  addContainerToLayout: (
    key: ContainerKey,
    anchor: ContainerKey,
    side: "left" | "right",
  ) => boolean;
  /** 并排是否放得下该容器(拖拽中用于决定落点高亮;与 addContainerToLayout 同一判据)。 */
  canAddContainerToLayout: (key: ContainerKey) => boolean;
  /** 让容器成为唯一列(退出并排),并聚焦。 */
  focusContainerExclusive: (key: ContainerKey) => void;
  /** 把容器移出并排布局(标签仍开着,二层状态保留)。它是唯一列时无操作。 */
  removeContainerFromLayout: (key: ContainerKey) => boolean;

  /** 在容器内打开会话标签并激活(容器随之打开、进入并排布局并聚焦)。已在其他窗格
      打开则聚焦过去。路由是权威,本方法由路由同步调用。 */
  openConversation: (container: ContainerKey, conversationId: string) => void;
  /** 聚焦窗格回到"新对话"态(不动已开标签)。 */
  clearActiveConversation: (container: ContainerKey) => void;
  /** 聚焦指定容器的指定窗格(容器随之成为激活容器)。返回该窗格的激活会话(便于调用方导航)。 */
  focusPane: (container: ContainerKey, index: number) => string | null;
  /** 关闭会话标签(自动定位所在窗格;多窗格下窗格随最后一个标签关闭而收起)。
      返回聚焦窗格随之应激活的会话(undefined = 聚焦窗格的激活标签未受影响,无需导航)。 */
  closeConversation: (container: ContainerKey, conversationId: string) => string | null | undefined;
  /** 批量关闭会话标签(右键菜单,作用于 anchor 所在窗格)。返回语义同 closeConversation。 */
  closeConversationsBatch: (container: ContainerKey, scope: "others" | "right" | "all", anchor: string) => string | null | undefined;
  /** J 轮分栏:把会话标签拖出为新窗格(插入到 toIndex 位置)并聚焦。
      源窗格只剩它一个标签、或可见列已达上限时拒绝。返回是否成功。 */
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
  layout: ContainerKey[];
  activeTab: ContainerKey;
  panes: Record<ContainerKey, ConversationPane[]>;
  focusedPane: Record<ContainerKey, number>;
}

const emptyPane = (): ConversationPane => ({ tabs: [], active: null });

/** flattenColumns 的兜底列(容器暂无窗格时占一列)。仅供读取,勿写入。 */
const FALLBACK_PANES: readonly ConversationPane[] = [emptyPane()];

/** 把"并排容器 × 各自窗格"摊平成屏幕列(渲染与列计数的唯一口径;纯函数便于单测)。 */
export function flattenColumns(
  layout: readonly ContainerKey[],
  panes: Readonly<Record<ContainerKey, ConversationPane[]>>,
): PaneColumn[] {
  const columns: PaneColumn[] = [];
  for (const container of layout) {
    const list = panes[container];
    const effective = list && list.length > 0 ? list : FALLBACK_PANES;
    effective.forEach((pane, paneIndex) => columns.push({ container, paneIndex, pane }));
  }
  return columns;
}

/** 读取容器窗格(缺省单个空窗格)。返回值仅供读取,写入前须拷贝。 */
function panesOf(state: Pick<ContainerTabsState, "panes">, container: ContainerKey): ConversationPane[] {
  const panes = state.panes[container];
  return panes && panes.length > 0 ? panes : [emptyPane()];
}

/** 容器占用的屏幕列数(= 其窗格数;缺省窗格算 1 列)。 */
function columnsOf(state: Pick<ContainerTabsState, "panes">, container: ContainerKey): number {
  return Math.max(1, state.panes[container]?.length ?? 1);
}

/** 并排布局占用的总列数(受 MAX_PANES 约束的唯一口径)。 */
function visibleColumns(
  state: Pick<ContainerTabsState, "panes">,
  layout: readonly ContainerKey[],
): number {
  return layout.reduce((sum, key) => sum + columnsOf(state, key), 0);
}

function sameOrder(a: readonly ContainerKey[], b: readonly ContainerKey[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** layout 归一化:去重、剔除未打开容器,并把次序对齐 openTabs;空则回落 [fallback]。
    结果与入参等价时原样返回入参 —— 引用稳定,免得每次调用都让订阅方重渲染。

    ★ 单一排序源:列的左右次序 = 一级标签的左右次序。于是"亮着的标签,从左到右,
    就是屏幕上的列",用户不需要额外线索去对应标签与列;拖标签排序同时排列,
    不存在两套次序打架。 */
function normalizeLayout(
  openTabs: readonly ContainerKey[],
  layout: readonly ContainerKey[],
  fallback: ContainerKey,
): ContainerKey[] {
  const wanted = new Set(layout);
  const ordered = openTabs.filter((key) => wanted.has(key));
  if (ordered.length === 0) return [fallback];
  return sameOrder(ordered, layout) ? (layout as ContainerKey[]) : ordered;
}

/** 把 key 移到 anchor 的左/右侧(anchor 不在列表内则原样返回)。 */
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

/** 让容器可见并聚焦:已在并排中则仅聚焦;否则接替当前焦点列的席位(其余列留着)。
    只改 layout、不动标签次序 —— 点标签/新建容器不该悄悄重排标签条(重排后列的左右
    也跟着变,用户会以为自己点错了)。列的左右由"标签次序"这唯一排序源导出。 */
function ensureVisible(
  state: Pick<ContainerTabsState, "openTabs" | "layout" | "activeTab" | "panes">,
  key: ContainerKey,
): Pick<PersistedShape, "openTabs" | "layout" | "activeTab"> {
  const openTabs = state.openTabs.includes(key) ? state.openTabs : [...state.openTabs, key];
  const current = normalizeLayout(openTabs, state.layout, key);
  if (current.includes(key)) return { openTabs, layout: current, activeTab: key };
  const layout = normalizeLayout(
    openTabs,
    current.map((item) => (item === state.activeTab ? key : item)),
    key,
  );
  return {
    openTabs,
    // 接替后仍超额(被替容器只占 1 列、新容器自己是多窗格)→ 退化为独占显示。
    layout: layout.includes(key) && visibleColumns(state, layout) <= MAX_PANES ? layout : [key],
    activeTab: key,
  };
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

/** localStorage 反序列化 + 自愈(含 v1→v2→v3 迁移)。导出供迁移测试直接喂样本数据:
    存量用户的标签布局要能无损升级,这条路径出错等于开机丢工作区。 */
export function sanitizePersistedTabs(raw: unknown): PersistedShape | null {
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

  // v3 迁移(K 轮):无 layout 的旧数据 = 单容器独占。恢复时还要守住可见列上限——
  // 旧数据可能存着 3 窗格的容器,与另一容器并排会超额。
  const rawLayout = Array.isArray(value.layout)
    ? value.layout.filter((key): key is string => typeof key === "string")
    : [activeTab];
  const layout = normalizeLayout(openTabs, [...new Set(rawLayout)], activeTab);
  const capped: ContainerKey[] = [];
  let used = 0;
  for (const key of layout) {
    const cost = Math.max(1, panes[key]?.length ?? 1);
    if (capped.length > 0 && used + cost > MAX_PANES) continue;
    capped.push(key);
    used += cost;
  }
  const finalLayout = capped.length > 0 ? capped : [activeTab];

  return {
    openTabs,
    layout: finalLayout,
    activeTab: finalLayout.includes(activeTab) ? activeTab : finalLayout[0]!,
    panes,
    focusedPane,
  };
}

function loadPersisted(): PersistedShape {
  const fallback: PersistedShape = {
    openTabs: [CHAT_CONTAINER],
    layout: [CHAT_CONTAINER],
    activeTab: CHAT_CONTAINER,
    panes: {},
    focusedPane: {},
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    return sanitizePersistedTabs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")) ?? fallback;
  } catch {
    return fallback;
  }
}

export const useContainerTabsStore = create<ContainerTabsState>((set, get) => ({
  ...loadPersisted(),

  activateContainer: (key) =>
    set((state) => {
      if (!state.openTabs.includes(key)) return state;
      if (state.activeTab === key && state.layout.includes(key)) return state;
      return ensureVisible(state, key);
    }),

  openContainer: (key) => set((state) => ensureVisible(state, key)),

  closeContainer: (key) =>
    set((state) => {
      const index = state.openTabs.indexOf(key);
      if (index < 0) return state;
      const openTabs = state.openTabs.filter((tab) => tab !== key);
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          layout: [CHAT_CONTAINER],
          activeTab: CHAT_CONTAINER,
        };
      }
      const activeTab =
        state.activeTab === key
          ? (openTabs[Math.min(index, openTabs.length - 1)] ?? openTabs[0]!)
          : state.activeTab;
      // 被关的容器退出并排;并排组因此空了就让新激活容器独占。
      const layout = normalizeLayout(
        openTabs,
        state.layout.filter((tab) => tab !== key),
        activeTab,
      );
      return {
        openTabs,
        layout,
        activeTab: layout.includes(activeTab) ? activeTab : layout[0]!,
      };
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
        return {
          openTabs: [CHAT_CONTAINER],
          layout: [CHAT_CONTAINER],
          activeTab: CHAT_CONTAINER,
        };
      }
      const activeTab = openTabs.includes(state.activeTab) ? state.activeTab : anchor;
      const layout = normalizeLayout(openTabs, state.layout, activeTab);
      return {
        openTabs,
        layout,
        activeTab: layout.includes(activeTab) ? activeTab : layout[0]!,
      };
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
      // 列次序跟着标签次序走(单一排序源)。
      return { openTabs, layout: normalizeLayout(openTabs, state.layout, state.activeTab) };
    }),

  addContainerToLayout: (key, anchor, side) => {
    const state = get();
    if (key === anchor) return false;
    if (!state.openTabs.includes(key) || !state.openTabs.includes(anchor)) return false;
    const layout = normalizeLayout(state.openTabs, state.layout, state.activeTab);
    if (!layout.includes(anchor)) return false;
    if (!layout.includes(key) && visibleColumns(state, layout) + columnsOf(state, key) > MAX_PANES) {
      return false;
    }
    // 单一排序源:先把一级标签移到 anchor 侧,列次序由 openTabs 归一化得出。
    const openTabs = moveBeside(state.openTabs, key, anchor, side);
    set({
      openTabs,
      layout: normalizeLayout(openTabs, [...layout, key], key),
      activeTab: key,
    });
    return true;
  },

  canAddContainerToLayout: (key) => {
    const state = get();
    if (!state.openTabs.includes(key)) return false;
    const layout = normalizeLayout(state.openTabs, state.layout, state.activeTab);
    if (layout.includes(key)) return true;
    return visibleColumns(state, layout) + columnsOf(state, key) <= MAX_PANES;
  },

  focusContainerExclusive: (key) =>
    set((state) =>
      state.openTabs.includes(key) ? { layout: [key], activeTab: key } : state,
    ),

  removeContainerFromLayout: (key) => {
    const state = get();
    const layout = normalizeLayout(state.openTabs, state.layout, state.activeTab);
    if (layout.length < 2 || !layout.includes(key)) return false;
    const index = layout.indexOf(key);
    const next = layout.filter((item) => item !== key);
    const activeTab =
      state.activeTab === key ? (next[Math.min(index, next.length - 1)] ?? next[0]!) : state.activeTab;
    set({ layout: next, activeTab });
    return true;
  },

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
        ...ensureVisible(state, container),
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
    const focusChanged = (state.focusedPane[container] ?? 0) !== clamped;
    const containerChanged = state.activeTab !== container && state.layout.includes(container);
    if (focusChanged || containerChanged) {
      set({
        ...(containerChanged ? { activeTab: container } : {}),
        ...(focusChanged
          ? { focusedPane: { ...state.focusedPane, [container]: clamped } }
          : {}),
      });
    }
    return panes[clamped]!.active;
  },

  closeConversation: (container, conversationId) => {
    const state = get();
    const panes = panesOf(state, container);
    const paneIdx = panes.findIndex((pane) => pane.tabs.includes(conversationId));
    if (paneIdx < 0) return undefined;
    const focused = clampFocus(state, container, panes.length);
    // 导航只在"聚焦列"上发生:并排时另一容器/另一窗格的关闭不该改路由。
    const isFocusedColumn = state.activeTab === container && paneIdx === focused;
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
      return isFocusedColumn ? (nextPanes[nextFocus]!.active ?? null) : undefined;
    }

    const nextActive = wasActive
      ? (nextTabs[Math.min(tabIdx, nextTabs.length - 1)] ?? null)
      : pane.active;
    const nextPanes = panes.map((p, i) => (i === paneIdx ? { tabs: nextTabs, active: nextActive } : p));
    set({ panes: { ...state.panes, [container]: nextPanes } });
    return wasActive && isFocusedColumn ? nextActive : undefined;
  },

  closeConversationsBatch: (container, scope, anchor) => {
    const state = get();
    const panes = panesOf(state, container);
    const paneIdx = panes.findIndex((pane) => pane.tabs.includes(anchor));
    if (paneIdx < 0) return undefined;
    const focused = clampFocus(state, container, panes.length);
    const isFocusedColumn = state.activeTab === container && paneIdx === focused;
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
      return isFocusedColumn ? (nextPanes[nextFocus]!.active ?? null) : undefined;
    }

    const activeStays = pane.active !== null && nextTabs.includes(pane.active);
    const nextActive = activeStays ? pane.active : nextTabs.length > 0 ? anchor : null;
    const nextPanes = panes.map((p, i) => (i === paneIdx ? { tabs: nextTabs, active: nextActive } : p));
    set({ panes: { ...state.panes, [container]: nextPanes } });
    return !activeStays && isFocusedColumn ? nextActive : undefined;
  },

  splitConversation: (container, conversationId, toIndex) => {
    const state = get();
    const panes = panesOf(state, container);
    // 上限按"屏幕可见列总数"算:并排容器各自的窗格都占列,分栏不能越过总额。
    const layout = normalizeLayout(state.openTabs, state.layout, state.activeTab);
    const inLayout = layout.includes(container);
    if ((inLayout ? visibleColumns(state, layout) : panes.length) >= MAX_PANES) return false;
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
      ...(inLayout && state.activeTab !== container ? { activeTab: container } : {}),
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
    // 落点容器成为激活容器(并排时把焦点交给用户放手的那一列)。
    const focusContainer =
      state.layout.includes(container) && state.activeTab !== container
        ? { activeTab: container }
        : {};
    if (fromIdx === target) {
      // 同窗格:只激活聚焦。
      const nextPanes = panes.map((p, i) => (i === fromIdx ? { ...p, active: conversationId } : p));
      set({
        ...focusContainer,
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
      ...focusContainer,
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
        Object.keys(state.focusedPane).some((key) => !keep(key)) ||
        state.layout.some((key) => !keep(key));
      if (stale.length === 0 && !staleState) return state;
      const openTabs = state.openTabs.filter((tab) => !stale.includes(tab));
      const panes = Object.fromEntries(Object.entries(state.panes).filter(([key]) => keep(key)));
      const focusedPane = Object.fromEntries(
        Object.entries(state.focusedPane).filter(([key]) => keep(key)),
      );
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          layout: [CHAT_CONTAINER],
          activeTab: CHAT_CONTAINER,
          panes,
          focusedPane,
        };
      }
      const activeTab = openTabs.includes(state.activeTab) ? state.activeTab : openTabs[0]!;
      const layout = normalizeLayout(openTabs, state.layout.filter(keep), activeTab);
      return {
        openTabs,
        layout,
        activeTab: layout.includes(activeTab) ? activeTab : layout[0]!,
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
          layout: state.layout,
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
