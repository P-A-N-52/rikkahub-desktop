import { create } from "zustand";

// ===== 双层标签页导航状态(工作区 M2-1;J 轮窗格分栏;L 轮分区模型一级分栏) =====
// 一层标签 = 容器("chat" 固定键 = 对话模式;其余键 = workspaceId);
// 二层标签 = 各容器内已打开的会话,按"窗格"分组:每容器有自己的窗格组与激活会话。
// L 轮起一级分栏与二级窗格完全同构:屏幕被切成若干"组",groups: ContainerKey[][],
// 每组持完整、有序的一级标签列表与自己的焦点标签(activeTab 落在哪组,哪组就显示它),
// 各组拥有自己的一级标签栏与内容区 —— 就像二级分栏后每列有自己的会话标签栏。
// 屏幕列 = Σ(各组焦点容器的窗格数),一级与二级共用同一个 MAX_PANES 上限。
// 纯前端 UI 状态,localStorage 持久化——服务端只关心 conversation.workspaceId 归属。
//
// 不变量:
// - openTabs 非空、无重复 = 各组成员 + 幽灵标签(不在任何组);次序 = 组次序 × 组内
//   次序,幽灵按上次激活先后在尾部。屏幕顺序 = 标签顺序:亮的标签从左到右就是屏幕
//   上的组,不存在两套次序。
// - groups 非空、组非空、无重复成员、成员 ⊆ openTabs;activeTab ∈ openTabs,且在组里
//   时必是该组成员。
// - 可见总列数 Σ|panes[c]|(c = 各组焦点标签)≤ MAX_PANES。
// - 每容器窗格数 1..MAX_PANES;同一会话在一个容器内只出现一次(跨窗格去重);
//   空窗格只允许在该容器窗格数为 1 时存在(多窗格下最后一个标签关闭即收起该窗格)。
// - focusedPane[c] ∈ [0, |panes[c]|)。
// 关闭 ≠ 删除:容器收起(或仅移出分栏)后其二层状态保留,重开即恢复。

export const CHAT_CONTAINER = "chat";

/** 可见列数上限(= Σ 各组焦点容器的窗格数):双栏是常规交互,三栏留给宽屏。 */
export const MAX_PANES = 3;

export type ContainerKey = string;

export interface ConversationPane {
  tabs: string[];
  active: string | null;
}

/** 屏幕上的一列:某容器的某个窗格。列的左右顺序 = 组顺序 × 组焦点容器的窗格顺序。 */
export interface PaneColumn {
  container: ContainerKey;
  /** 容器内窗格下标(不是全局列号)——所有 store 方法都按容器内下标寻址。 */
  paneIndex: number;
  pane: ConversationPane;
}

interface ContainerTabsState {
  openTabs: ContainerKey[];
  /** 各组的一级标签列表(左→右;每组非空、有序)。组数 >1 即分栏。 */
  groups: ContainerKey[][];
  /** 全局焦点容器:路由 /c/:id、侧栏、热键跟随它。在组里时 = 该组的焦点标签;
      不在组里(幽灵态被激活)= 独占整屏,布局原样保留。 */
  activeTab: ContainerKey;
  /** 容器 → 窗格数组(有序,左→右)。缺省视作单个空窗格。 */
  panes: Record<ContainerKey, ConversationPane[]>;
  /** 容器 → 聚焦窗格下标(路由/侧栏/快捷键跟随焦点列)。 */
  focusedPane: Record<ContainerKey, number>;

  activateContainer: (key: ContainerKey) => void;
  /** 打开并激活容器(已开则仅激活;不在屏上则接替焦点组席位)。 */
  openContainer: (key: ContainerKey) => void;
  /** 收起容器标签。关闭激活容器:若它在某个组里,焦点先给同组右邻(无则左邻),
      该组空了即整组消失;关的是独占的幽灵时依次尝试各组焦点、其余幽灵,最后回落
      对话模式。 */
  closeContainer: (key: ContainerKey) => void;
  /** 批量收起容器标签(右键菜单):others=只留 anchor;right=关 anchor 右侧(同组优先,
      同组没有向右跨组/跨幽灵);all=全关(回落对话模式)。 */
  closeContainersBatch: (scope: "others" | "right" | "all", anchor: ContainerKey) => void;

  /** 在容器内打开会话标签并激活(容器随之打开、进入分栏并聚焦)。已在其他窗格
      打开则聚焦过去。路由是权威,本方法由路由同步调用。 */
  openConversation: (container: ContainerKey, conversationId: string) => void;
  /** 聚焦窗格回到"新对话"态(不动已开标签)。 */
  clearActiveConversation: (container: ContainerKey) => void;
  /** 聚焦指定容器的指定窗格(容器随之成为激活容器)。返回该窗格的激活会话(便于调用方导航)。 */
  focusPane: (container: ContainerKey, index: number) => string | null;
  /** 关闭会话标签(自动定位所在窗格;多窗格下窗格随最后一个标签关闭而收起)。
      返回焦点列随之应激活的会话(undefined = 焦点列的激活标签未受影响,无需导航)。 */
  closeConversation: (container: ContainerKey, conversationId: string) => string | null | undefined;
  /** 批量关闭会话标签(右键菜单,作用于 anchor 所在窗格)。返回语义同 closeConversation。 */
  closeConversationsBatch: (container: ContainerKey, scope: "others" | "right" | "all", anchor: string) => string | null | undefined;
  /** J 轮分栏:把会话标签拖出为新窗格(插入到 toIndex 位置)并聚焦。
      源窗格只剩它一个标签、或可见列已达上限时拒绝。返回是否成功。 */
  splitConversation: (container: ContainerKey, conversationId: string, toIndex: number) => boolean;
  /** J 轮跨栏移动:把会话标签移入既有窗格尾部并激活聚焦;源窗格空了即收起。 */
  moveConversationToPane: (container: ContainerKey, conversationId: string, toPane: number) => void;

  /** 一级分栏:把容器拆为 anchor 容器所在组左/右侧的新组(它"带着"自己的会话标签)。
      与二级 splitConversation 同构:目标从原组移除(原组空了即消失)再自成新组;
      超额/未打开/anchor 不在屏上时拒绝。 */
  splitContainerBeside: (key: ContainerKey, anchor: ContainerKey, side: "left" | "right") => boolean;
  /** 把容器移入既有组的尾部并激活(组间移动;已在该组内 = 组内挪到尾部);
      原组空了即整组消失;幽灵态(开过但不在任何组)= 直接并入目标组。
      key 未打开时无操作。 */
  moveContainerToGroup: (key: ContainerKey, toGroupIndex: number) => boolean;
  /** 把容器挪到 anchor 的左/右侧:同组 = 组内重排;跨组 = 移到 anchor 所在组的
      对应位置(原组空了即消失)。组内落点就是自身时无操作也返回 true。 */
  moveContainerBeside: (key: ContainerKey, anchor: ContainerKey, side: "left" | "right") => boolean;
  /** 移出分栏:容器退出所在组、变回幽灵态(标签仍开,二层状态保留);原组空了即整组
      消失,焦点移交规则同 closeContainer。不在任何组、或它是唯一组(无"外"可退)时无操作。 */
  unsplitContainer: (key: ContainerKey) => boolean;
  /** 分栏是否放得下该容器(拖拽中决定落点高亮;与 splitContainerBeside 同一判据)。 */
  canSplitContainer: (key: ContainerKey) => boolean;

  /** 会话被删除时从所有容器所有窗格中移除。 */
  forgetConversation: (conversationId: string) => void;
  /** 工作区被删除后清理其容器标签与二层状态。 */
  pruneWorkspaces: (validWorkspaceIds: ReadonlySet<string>) => void;
}

const STORAGE_KEY = "rikkahub.container-tabs.v2";

interface PersistedShape {
  openTabs: ContainerKey[];
  groups: ContainerKey[][];
  activeTab: ContainerKey;
  panes: Record<ContainerKey, ConversationPane[]>;
  focusedPane: Record<ContainerKey, number>;
}

const emptyPane = (): ConversationPane => ({ tabs: [], active: null });

/** flattenColumns 的兜底列(容器暂无窗格时占一列)。仅供读取,勿写入。 */
const FALLBACK_PANES: readonly ConversationPane[] = [emptyPane()];

/** 把"各组 × 组焦点容器的窗格"摊平成屏幕列(渲染与列计数的唯一口径;纯函数便于单测)。
    activeTab 落在哪组,哪组的焦点就是它(该组正显示它);activeTab 不在任何组(幽灵态
    独占)时不参与摊平。 */
export function flattenColumns(
  groups: readonly ContainerKey[][],
  panes: Readonly<Record<ContainerKey, ConversationPane[]>>,
  activeTab: ContainerKey,
): PaneColumn[] {
  const columns: PaneColumn[] = [];
  for (const group of groups) {
    const focus = group.includes(activeTab) ? activeTab : group[0];
    if (focus === undefined) continue;
    const list = panes[focus];
    const effective = list && list.length > 0 ? list : FALLBACK_PANES;
    effective.forEach((pane, paneIndex) => columns.push({ container: focus, paneIndex, pane }));
  }
  return columns;
}

/** 同组的另一个成员(任一即可)——"把某容器从本组拆出去"要用同组兄弟当锚点:
    屏上的列都属于各组焦点容器,拖焦点标签时它悬停到的就是自己的列,拿自己当锚点会被
    `key === anchor` 挡掉。返回 null = 本组只有它自己(已是独立组,无可拆)。
    落点按组粒度计算(锚点组的左/右),所以取哪个兄弟都等价。 */
export function groupSiblingOf(
  groups: readonly ContainerKey[][],
  key: ContainerKey,
): ContainerKey | null {
  const group = groups.find((item) => item.includes(key));
  return group?.find((member) => member !== key) ?? null;
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

/** 各组的焦点标签(activeTab 所在组 = activeTab,其余组 = 组首)。 */
function groupFocusKeys(
  groups: readonly ContainerKey[][],
  activeTab: ContainerKey,
): ContainerKey[] {
  return groups.map((group) => (group.includes(activeTab) ? activeTab : group[0]!));
}

/** 分栏占用的总列数(受 MAX_PANES 约束的唯一口径)。 */
function visibleColumns(
  state: Pick<ContainerTabsState, "panes">,
  groups: readonly ContainerKey[][],
  activeTab: ContainerKey,
): number {
  return groupFocusKeys(groups, activeTab).reduce((sum, key) => sum + columnsOf(state, key), 0);
}

/** openTabs 次序 = 组次序 × 组内次序,幽灵缀在尾部。任一变化都经它重建,
    保证"屏幕顺序 = 标签顺序"这一单一排序源。 */
function flattenOpenTabs(
  groups: readonly ContainerKey[][],
  ghosts: readonly ContainerKey[],
): ContainerKey[] {
  return [...groups.flat(), ...ghosts];
}

/** 从各组移除 key(空组整组删除)。返回 [新 groups, 原组下标, 组内下标](未在组里时后两者 -1)。 */
function removeFromGroups(
  groups: readonly ContainerKey[][],
  key: ContainerKey,
): { groups: ContainerKey[][]; fromGroup: number; fromIndex: number } {
  let fromGroup = -1;
  let fromIndex = -1;
  const next: ContainerKey[][] = [];
  groups.forEach((group, gi) => {
    const idx = group.indexOf(key);
    if (idx < 0) {
      next.push([...group]);
      return;
    }
    fromGroup = gi;
    fromIndex = idx;
    const rest = group.filter((item) => item !== key);
    if (rest.length > 0) next.push(rest);
  });
  return { groups: next, fromGroup, fromIndex };
}

/** 让容器可见并聚焦。与二级"打开会话进聚焦窗格"同构:
    - 已在某个组里 = 仅聚焦(该组焦点换成它);
    - 幽灵态(开过但不在任何组)= 接替焦点组席位(被顶容器退幽灵、标签仍开);
    - 完全没开过 = 追加进焦点组(不把现有容器踢下屏)。 */
function ensureVisible(
  state: Pick<ContainerTabsState, "openTabs" | "groups" | "activeTab" | "panes">,
  key: ContainerKey,
): Pick<PersistedShape, "openTabs" | "groups" | "activeTab"> {
  const inGroup = state.groups.some((group) => group.includes(key));
  if (inGroup) return { openTabs: state.openTabs, groups: state.groups, activeTab: key };

  // 焦点组 = activeTab 所在组(activeTab 自己是幽灵则是最右组)。
  const seatIndex = (() => {
    const own = state.groups.findIndex((group) => group.includes(state.activeTab));
    return own >= 0 ? own : state.groups.length - 1;
  })();

  if (state.openTabs.includes(key)) {
    // 幽灵态被激活:接替焦点组席位,被顶容器退幽灵(标签仍开,二层状态保留)。
    const displaced = state.groups[seatIndex]?.filter((tab) => tab !== key) ?? [];
    const groups = state.groups.map((group, gi) => (gi === seatIndex ? [key] : [...group]));
    const openTabs = [
      ...state.openTabs.filter((tab) => tab !== key && !displaced.includes(tab)),
      ...displaced,
      key,
    ];
    return {
      openTabs,
      // 接替后仍超额(被替容器只占 1 列、新容器自己是多窗格)→ 退化为独占显示。
      groups: visibleColumns(state, groups, key) <= MAX_PANES ? groups : [[key]],
      activeTab: key,
    };
  }

  // 新容器:追加进焦点组,不动现有席位。
  const groups = state.groups.map((group, gi) =>
    gi === seatIndex ? [...group, key] : [...group],
  );
  const openTabs = [...state.openTabs, key];
  return {
    openTabs,
    // 追加后仍超额(焦点组原焦点只占 1 列、新容器自己是多窗格)→ 退化为独占显示。
    groups: visibleColumns(state, groups, key) <= MAX_PANES ? groups : [[key]],
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

/** localStorage 反序列化 + 自愈(含 v1→…→v5 迁移)。导出供迁移测试直接喂样本数据:
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
    // v2 起形状(J 轮):窗格数组直存。
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

  // v5 起:groups 是 ContainerKey[][];v3/v4 是焦点容器一维数组(语义 = 各自单容器组),
  // v2 无布局字段 = 激活容器独占。统一落成"组列表",再按 openTabs 归一化。
  const rawGroups: unknown[][] = (() => {
    if (Array.isArray(value.groups)) {
      return value.groups.map((entry) => (Array.isArray(entry) ? entry : [entry]));
    }
    if (Array.isArray(value.layout)) return value.layout.map((entry) => [entry]);
    return [[activeTab]];
  })();
  const wanted = new Set(openTabs);
  const groups: ContainerKey[][] = [];
  const seen = new Set<ContainerKey>();
  for (const rawGroup of rawGroups) {
    const group: ContainerKey[] = [];
    for (const key of rawGroup) {
      if (typeof key !== "string" || !wanted.has(key) || seen.has(key)) continue;
      seen.add(key);
      group.push(key);
    }
    if (group.length > 0) groups.push(group);
  }
  // 恢复时守住可见列上限:旧数据可能存着 3 窗格的容器,与另一容器并排会超额。
  const capped: ContainerKey[][] = [];
  let used = 0;
  for (const group of groups) {
    const focus = group.includes(activeTab) ? activeTab : group[0]!;
    const cost = Math.max(1, panes[focus]?.length ?? 1);
    if (capped.length > 0 && used + cost > MAX_PANES) continue;
    capped.push(group);
    used += cost;
  }
  const inGroups = new Set(capped.flat());
  const finalGroups: ContainerKey[][] =
    capped.length > 0 ? capped : [[inGroups.has(activeTab) ? activeTab : openTabs[0]!]];
  // 被挤出分栏/从未进组的标签保持开启(幽灵态),次序 = 组 × 组内,幽灵在尾部。
  const finalOpenTabs = flattenOpenTabs(
    finalGroups,
    openTabs.filter((tab) => !finalGroups.some((group) => group.includes(tab))),
  );

  return {
    openTabs: finalOpenTabs,
    groups: finalGroups,
    activeTab,
    panes,
    focusedPane,
  };
}

function loadPersisted(): PersistedShape {
  const fallback: PersistedShape = {
    openTabs: [CHAT_CONTAINER],
    groups: [[CHAT_CONTAINER]],
    activeTab: CHAT_CONTAINER,
    panes: {},
    focusedPane: {},
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    // 结构变了,顺手清掉旧键,免得老数据在本地常驻。
    localStorage.removeItem("rikkahub.container-tabs.v1");
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
      if (state.activeTab === key) return state;
      return ensureVisible(state, key);
    }),

  openContainer: (key) => set((state) => ensureVisible(state, key)),

  closeContainer: (key) =>
    set((state) => {
      const index = state.openTabs.indexOf(key);
      if (index < 0) return state;
      const removal = removeFromGroups(state.groups, key);
      const ghosts = state.openTabs.filter(
        (tab) => tab !== key && !state.groups.some((group) => group.includes(tab)),
      );
      const openTabs = flattenOpenTabs(removal.groups, ghosts);
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          groups: [[CHAT_CONTAINER]],
          activeTab: CHAT_CONTAINER,
        };
      }
      // 焦点交接:关的是激活容器才需要;同组右邻 → 同组左邻 → 组空则下一组焦点/上一组
      // 焦点;关的是独占幽灵时依次尝试各组焦点与其余幽灵。
      const activeTab = (() => {
        if (state.activeTab !== key) return state.activeTab;
        if (removal.fromGroup >= 0) {
          const group = state.groups[removal.fromGroup]!;
          const right = group[removal.fromIndex + 1];
          if (right !== undefined) return right;
          const left = group[removal.fromIndex - 1];
          if (left !== undefined) return left;
          // 该组空了:焦点交给它的后继组(焦点 = 组首),无后继给前驱。
          if (removal.groups.length < state.groups.length) {
            const next = removal.groups[Math.min(removal.fromGroup, removal.groups.length - 1)];
            if (next) return next[0]!;
          }
        } else {
          const focuses = groupFocusKeys(removal.groups, removal.groups[0]?.[0] ?? CHAT_CONTAINER);
          if (focuses.length > 0) return focuses[focuses.length - 1]!;
          if (ghosts.length > 0) return ghosts[ghosts.length - 1]!;
        }
        return CHAT_CONTAINER;
      })();
      return { openTabs, groups: removal.groups, activeTab };
    }),

  closeContainersBatch: (scope, anchor) =>
    set((state) => {
      const index = state.openTabs.indexOf(anchor);
      if (index < 0) return state;
      if (scope === "all") {
        return {
          openTabs: [CHAT_CONTAINER],
          groups: [[CHAT_CONTAINER]],
          activeTab: CHAT_CONTAINER,
        };
      }
      const anchorGroup = state.groups.findIndex((group) => group.includes(anchor));
      const keep = (tab: ContainerKey): boolean => {
        if (scope === "others") return tab === anchor;
        // right:同组内关右侧;幽灵/独占时关全局右侧。
        if (anchorGroup < 0) return state.openTabs.indexOf(tab) <= index;
        const group = state.groups[anchorGroup]!;
        const at = group.indexOf(tab);
        return at >= 0 ? at <= group.indexOf(anchor) : false;
      };
      const groups = state.groups
        .map((group) => group.filter(keep))
        .filter((group) => group.length > 0);
      const ghosts = state.openTabs.filter(
        (tab) => !state.groups.some((group) => group.includes(tab)) && keep(tab),
      );
      const openTabs = flattenOpenTabs(groups, ghosts);
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          groups: [[CHAT_CONTAINER]],
          activeTab: CHAT_CONTAINER,
        };
      }
      const activeTab = openTabs.includes(state.activeTab) ? state.activeTab : anchor;
      return { openTabs, groups, activeTab };
    }),

  splitContainerBeside: (key, anchor, side) => {
    const state = get();
    if (key === anchor) return false;
    if (!state.openTabs.includes(key) || !state.openTabs.includes(anchor)) return false;
    // 先把 key 从原组摘出来(原组空了即整组消失),anchor 若与 key 同组会留在 removal 里。
    // anchorGroup 直接在 removal.groups 里定位,天然已随"原组抽空"前移,无需再调。
    const removal = removeFromGroups(state.groups, key);
    const anchorGroup = removal.groups.findIndex((group) => group.includes(anchor));
    let groups: ContainerKey[][];
    if (anchorGroup >= 0) {
      const insertAt = side === "left" ? anchorGroup : anchorGroup + 1;
      groups = [
        ...removal.groups.slice(0, insertAt),
        [key],
        ...removal.groups.slice(insertAt),
      ];
    } else {
      // anchor 是幽灵(开过但不在任何组):把它立成新组(放在最右,即焦点组席位),
      // key 落到它左/右 —— "拆到它旁边"对它而言就是"上屏成组"。
      const seat: ContainerKey[][] = [...removal.groups, [anchor]];
      const insertAt = side === "left" ? seat.length - 1 : seat.length;
      groups = [...seat.slice(0, insertAt), [key], ...seat.slice(insertAt)];
    }
    const activeTab = key;
    const ghosts = state.openTabs.filter(
      (tab) => tab !== key && tab !== anchor && !groups.some((group) => group.includes(tab)),
    );
    const openTabs = flattenOpenTabs(groups, ghosts);
    if (visibleColumns(state, groups, activeTab) > MAX_PANES) return false;
    set({ openTabs, groups, activeTab });
    return true;
  },

  moveContainerToGroup: (key, toGroupIndex) => {
    const state = get();
    if (!state.openTabs.includes(key)) return false;
    const target = state.groups[toGroupIndex];
    if (!target) return false;
    const removal = removeFromGroups(state.groups, key);
    // 原组被抽空(消失)且在目标组之前时,目标组下标前移一位;原组没空、或 key 是
    // 幽灵(从没在组里)时,目标组下标不动。
    const sourceEmptied = removal.groups.length < state.groups.length;
    const adjusted =
      sourceEmptied && removal.fromGroup < toGroupIndex ? toGroupIndex - 1 : toGroupIndex;
    const groups = removal.groups.map((group, gi) => (gi === adjusted ? [...group, key] : group));
    const ghosts = state.openTabs.filter(
      (tab) => tab !== key && !state.groups.some((group) => group.includes(tab)),
    );
    set({
      openTabs: flattenOpenTabs(groups, ghosts),
      groups,
      activeTab: key,
    });
    return true;
  },

  moveContainerBeside: (key, anchor, side) => {
    const state = get();
    if (key === anchor) return true;
    const removal = removeFromGroups(state.groups, key);
    if (removal.fromGroup < 0) return false;
    // anchorGroup 直接在 removal.groups 里定位,天然已随"原组抽空"前移,无需再调。
    const adjustedGroup = removal.groups.findIndex((group) => group.includes(anchor));
    if (adjustedGroup < 0) return false;
    const anchorIndex = removal.groups[adjustedGroup]!.indexOf(anchor);
    const insertAt = side === "left" ? anchorIndex : anchorIndex + 1;
    const groups = removal.groups.map((group, gi) => {
      if (gi !== adjustedGroup) return group;
      const next = [...group];
      next.splice(insertAt, 0, key);
      return next;
    });
    const ghosts = state.openTabs.filter(
      (tab) => tab !== key && !state.groups.some((group) => group.includes(tab)),
    );
    set({ openTabs: flattenOpenTabs(groups, ghosts), groups });
    return true;
  },

  unsplitContainer: (key) => {
    const state = get();
    const removal = removeFromGroups(state.groups, key);
    if (removal.fromGroup < 0 || state.groups.length < 2) return false;
    const groups = removal.groups;
    const ghosts = [
      ...state.openTabs.filter(
        (tab) => tab !== key && !state.groups.some((group) => group.includes(tab)),
      ),
      key,
    ];
    const openTabs = flattenOpenTabs(groups, ghosts);
    // 焦点交接与 closeContainer 同源:本组还有成员就给同组右/左邻,本组空了交给后继组。
    const activeTab = (() => {
      if (state.activeTab !== key) return state.activeTab;
      const group = state.groups[removal.fromGroup]!;
      const right = group[removal.fromIndex + 1];
      if (right !== undefined) return right;
      const left = group[removal.fromIndex - 1];
      if (left !== undefined) return left;
      const next = groups[Math.min(removal.fromGroup, groups.length - 1)];
      return next ? next[0]! : CHAT_CONTAINER;
    })();
    set({ openTabs, groups, activeTab });
    return true;
  },

  canSplitContainer: (key) => {
    const state = get();
    if (!state.openTabs.includes(key)) return false;
    const removal = removeFromGroups(state.groups, key);
    // 已在屏上的容器横移不增列;只有"不在屏上 → 拆成新组"才需要检查列额。
    if (removal.fromGroup >= 0) return true;
    return visibleColumns(state, [...removal.groups, [key]], key) <= MAX_PANES;
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
    const inGroup = state.groups.some((group) => group.includes(container));
    const containerChanged = inGroup && state.activeTab !== container;
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
    // 导航只在"焦点列"上发生:分栏时另一容器/另一窗格的关闭不该改路由。
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
    // 上限按"屏幕可见列总数"算:各组焦点容器的窗格都占列,二级分栏不能越过总额。
    const onScreen = state.groups.some((group) => group.includes(container));
    if (
      (onScreen ? visibleColumns(state, state.groups, state.activeTab) : panes.length) >= MAX_PANES
    ) {
      return false;
    }
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
      ...(onScreen && state.activeTab !== container ? { activeTab: container } : {}),
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
    // 落点容器成为激活容器(分栏时把焦点交给用户放手的那一列)。
    const inGroup = state.groups.some((group) => group.includes(container));
    const focusContainer = inGroup && state.activeTab !== container ? { activeTab: container } : {};
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
      const keep = (key: string) => key === CHAT_CONTAINER || validWorkspaceIds.has(key);
      const stale = state.openTabs.filter((tab) => !keep(tab));
      const staleState =
        Object.keys(state.panes).some((key) => !keep(key)) ||
        Object.keys(state.focusedPane).some((key) => !keep(key)) ||
        state.groups.some((group) => group.some((key) => !keep(key)));
      if (stale.length === 0 && !staleState) return state;
      const groups = state.groups
        .map((group) => group.filter(keep))
        .filter((group) => group.length > 0);
      const ghosts = state.openTabs.filter(
        (tab) => keep(tab) && !state.groups.some((group) => group.includes(tab)),
      );
      const panes = Object.fromEntries(Object.entries(state.panes).filter(([key]) => keep(key)));
      const focusedPane = Object.fromEntries(
        Object.entries(state.focusedPane).filter(([key]) => keep(key)),
      );
      const openTabs = flattenOpenTabs(groups, ghosts);
      if (openTabs.length === 0) {
        return {
          openTabs: [CHAT_CONTAINER],
          groups: [[CHAT_CONTAINER]],
          activeTab: CHAT_CONTAINER,
          panes,
          focusedPane,
        };
      }
      const activeTab = openTabs.includes(state.activeTab) ? state.activeTab : openTabs[0]!;
      return { openTabs, groups, activeTab, panes, focusedPane };
    }),
}));

if (typeof localStorage !== "undefined") {
  useContainerTabsStore.subscribe((state) => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openTabs: state.openTabs,
          groups: state.groups,
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
