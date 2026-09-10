// 双层标签页状态机(M2-1;J 轮窗格分栏;K 轮组模型一级分栏)不变量:
// openTabs 非空/无重复;groups ⊆ openTabs 且与 openTabs 同序;activeTab ∈ groups;
// 可见列总数 Σ|panes[c]|(c∈groups) ≤ MAX_PANES;同会话跨窗格去重;
// 多窗格下空窗格即收起;关闭=收起(二层状态保留);工作区删除后标签自愈回落。
import { beforeEach, describe, expect, test } from "bun:test";

import {
  CHAT_CONTAINER,
  MAX_PANES,
  flattenColumns,
  sanitizePersistedTabs,
  useContainerTabsStore,
} from "~/stores/container-tabs-store";

function reset() {
  useContainerTabsStore.setState({
    openTabs: [CHAT_CONTAINER],
    groups: [CHAT_CONTAINER],
    activeTab: CHAT_CONTAINER,
    panes: {},
    focusedPane: {},
  });
}

beforeEach(reset);

const store = () => useContainerTabsStore.getState();
const panes = (container: string) => store().panes[container] ?? [];

describe("容器标签", () => {
  test("首启迁移即默认态:仅对话模式容器", () => {
    expect(store().openTabs).toEqual([CHAT_CONTAINER]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });

  test("openContainer 幂等打开并激活", () => {
    store().openContainer("ws1");
    store().openContainer("ws1");
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws1"]);
    expect(store().activeTab).toBe("ws1");
  });

  test("关闭激活容器 → 激活右邻,无右邻取左邻", () => {
    store().openContainer("ws1");
    store().openContainer("ws2");
    store().activateContainer("ws1");
    store().closeContainer("ws1");
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws2"]);
    expect(store().activeTab).toBe("ws2");
    store().closeContainer("ws2");
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });

  test("关闭非激活容器不动 activeTab", () => {
    store().openContainer("ws1");
    store().closeContainer(CHAT_CONTAINER);
    expect(store().openTabs).toEqual(["ws1"]);
    expect(store().activeTab).toBe("ws1");
  });

  test("关到最后一个回落对话模式", () => {
    store().closeContainer(CHAT_CONTAINER);
    expect(store().openTabs).toEqual([CHAT_CONTAINER]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });

  test("setOpenTabsOrder 重排标签;组次序跟随(屏幕顺序 = 标签顺序)", () => {
    store().openContainer("ws1");
    store().openContainer("ws2");
    store().setOpenTabsOrder(["ws2", CHAT_CONTAINER, "ws1"]);
    expect(store().openTabs).toEqual(["ws2", CHAT_CONTAINER, "ws1"]);
    // 长度不符/集合不符的输入被拒(防调用方把标签弄丢)
    store().setOpenTabsOrder([CHAT_CONTAINER]);
    expect(store().openTabs).toEqual(["ws2", CHAT_CONTAINER, "ws1"]);
    store().setOpenTabsOrder(["ws2", CHAT_CONTAINER, "ghost"]);
    expect(store().openTabs).toEqual(["ws2", CHAT_CONTAINER, "ws1"]);
  });
});

describe("会话标签(单窗格)", () => {
  test("openConversation 连带打开容器并激活会话", () => {
    store().openConversation("ws1", "c1");
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws1"]);
    expect(store().activeTab).toBe("ws1");
    expect(panes("ws1")).toEqual([{ tabs: ["c1"], active: "c1" }]);
  });

  test("重复打开同会话不重复建标签", () => {
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c1");
    expect(panes("ws1")[0]!.tabs).toEqual(["c1", "c2"]);
    expect(panes("ws1")[0]!.active).toBe("c1");
  });

  test("关闭激活会话标签 → 返回应激活的邻居;关闭非激活返回 undefined", () => {
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c3");
    expect(store().closeConversation("ws1", "c1")).toBeUndefined();
    store().openConversation("ws1", "c2");
    expect(store().closeConversation("ws1", "c2")).toBe("c3");
    expect(store().closeConversation("ws1", "c3")).toBeNull();
    expect(panes("ws1")[0]!.tabs).toEqual([]);
  });

  test("容器收起后二层状态保留,重开恢复", () => {
    store().openConversation("ws1", "c1");
    store().closeContainer("ws1");
    expect(panes("ws1")[0]!.tabs).toEqual(["c1"]);
    store().openContainer("ws1");
    expect(panes("ws1")[0]!.active).toBe("c1");
  });

  test("forgetConversation 清所有容器中的标签与激活位", () => {
    store().openConversation(CHAT_CONTAINER, "c1");
    store().openConversation("ws1", "c1");
    store().forgetConversation("c1");
    expect(panes(CHAT_CONTAINER)[0]!.tabs).toEqual([]);
    expect(panes("ws1")[0]!.tabs).toEqual([]);
    expect(panes("ws1")[0]!.active).toBeNull();
  });
});

describe("窗格分栏(J 轮)", () => {
  function openThree() {
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c3");
  }

  test("splitConversation 拖出为新窗格并聚焦", () => {
    openThree();
    expect(store().splitConversation("ws1", "c2", 1)).toBe(true);
    expect(panes("ws1")).toEqual([
      { tabs: ["c1", "c3"], active: "c3" },
      { tabs: ["c2"], active: "c2" },
    ]);
    expect(store().focusedPane.ws1).toBe(1);
  });

  test("源窗格仅剩一个标签时拒绝分栏", () => {
    store().openConversation("ws1", "c1");
    expect(store().splitConversation("ws1", "c1", 1)).toBe(false);
    expect(panes("ws1")).toHaveLength(1);
  });

  test("达到 MAX_PANES 上限后拒绝分栏", () => {
    openThree();
    store().openConversation("ws1", "c4");
    store().splitConversation("ws1", "c2", 1);
    store().splitConversation("ws1", "c3", 2);
    expect(panes("ws1")).toHaveLength(MAX_PANES);
    expect(store().splitConversation("ws1", "c4", 1)).toBe(false);
  });

  test("openConversation 命中其他窗格 → 聚焦过去,不建重复标签", () => {
    openThree();
    store().splitConversation("ws1", "c2", 1);
    store().focusPane("ws1", 0);
    store().openConversation("ws1", "c2");
    expect(store().focusedPane.ws1).toBe(1);
    expect(panes("ws1")[0]!.tabs).toEqual(["c1", "c3"]);
    expect(panes("ws1")[1]!.tabs).toEqual(["c2"]);
  });

  test("moveConversationToPane 跨栏移动;源窗格空了即收起", () => {
    openThree();
    store().splitConversation("ws1", "c3", 1);
    store().moveConversationToPane("ws1", "c1", 1);
    expect(panes("ws1")).toEqual([
      { tabs: ["c2"], active: "c2" },
      { tabs: ["c3", "c1"], active: "c1" },
    ]);
    store().moveConversationToPane("ws1", "c2", 1);
    // 源窗格(0)收起,只剩一个窗格,下标回落
    expect(panes("ws1")).toEqual([{ tabs: ["c3", "c1", "c2"], active: "c2" }]);
    expect(store().focusedPane.ws1).toBe(0);
  });

  test("关闭窗格最后一个标签 → 窗格收起,聚焦回落并返回导航目标", () => {
    openThree();
    store().splitConversation("ws1", "c3", 1);
    // 聚焦在新窗格(1),关掉它唯一的标签
    expect(store().closeConversation("ws1", "c3")).toBe("c2");
    expect(panes("ws1")).toEqual([{ tabs: ["c1", "c2"], active: "c2" }]);
    expect(store().focusedPane.ws1).toBe(0);
  });

  test("非聚焦窗格内关闭激活标签 → 状态更新但不导航(返回 undefined)", () => {
    openThree();
    store().openConversation("ws1", "c4");
    store().splitConversation("ws1", "c4", 1);
    store().focusPane("ws1", 0);
    // 窗格1 的激活标签 c4 有邻居时:先给它加一个
    store().moveConversationToPane("ws1", "c3", 1);
    store().focusPane("ws1", 0);
    expect(store().closeConversation("ws1", "c3")).toBeUndefined();
    expect(panes("ws1")[1]!.tabs).toEqual(["c4"]);
  });

  test("closeConversationsBatch 作用于 anchor 所在窗格;全关时窗格收起", () => {
    openThree();
    store().splitConversation("ws1", "c3", 1);
    store().moveConversationToPane("ws1", "c2", 1);
    // 窗格1 = [c3, c2](聚焦),窗格0 = [c1]
    expect(store().closeConversationsBatch("ws1", "all", "c3")).toBe("c1");
    expect(panes("ws1")).toEqual([{ tabs: ["c1"], active: "c1" }]);
  });

  test("forgetConversation 收起随之变空的窗格", () => {
    openThree();
    store().splitConversation("ws1", "c3", 1);
    store().forgetConversation("c3");
    expect(panes("ws1")).toEqual([{ tabs: ["c1", "c2"], active: "c2" }]);
    expect(store().focusedPane.ws1).toBe(0);
  });

  test("focusPane 返回目标窗格激活会话", () => {
    openThree();
    store().splitConversation("ws1", "c2", 1);
    expect(store().focusPane("ws1", 0)).toBe("c3");
    expect(store().focusPane("ws1", 99)).toBe("c2");
    expect(store().focusedPane.ws1).toBe(1);
  });
});

describe("pruneWorkspaces", () => {
  test("删除的工作区标签被清理,激活位回落", () => {
    store().openConversation("ws1", "c1");
    store().openContainer("ws2");
    store().activateContainer("ws1");
    store().pruneWorkspaces(new Set(["ws2"]));
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws2"]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
    expect(store().groups).toEqual([CHAT_CONTAINER]);
    expect(store().panes.ws1).toBeUndefined();
  });

  test("chat 容器永不被清理", () => {
    store().pruneWorkspaces(new Set());
    expect(store().openTabs).toEqual([CHAT_CONTAINER]);
  });

  test("分栏中的容器被删除 → 该组消失,剩余组接管焦点", () => {
    store().openConversation(CHAT_CONTAINER, "c0");
    store().openConversation("ws1", "c1");
    // 落点语义:key 拆到"已在屏上的" anchor 旁。此刻分组是 [ws1]。
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    expect(store().groups).toEqual([CHAT_CONTAINER, "ws1"]);
    store().pruneWorkspaces(new Set());
    expect(store().groups).toEqual([CHAT_CONTAINER]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });
});

describe("一级容器分栏(K 轮组模型)", () => {
  test("splitContainerBeside 左/右拆组并聚焦;屏幕顺序 = 标签顺序", () => {
    store().openContainer("ws1");
    store().openContainer("ws2");
    // 标签条 [chat, ws1, ws2],当前独占 ws2
    expect(store().groups).toEqual(["ws2"]);
    expect(store().splitContainerBeside(CHAT_CONTAINER, "ws2", "left")).toBe(true);
    // chat 被移到 ws2 左侧 → 标签次序即组次序
    expect(store().openTabs).toEqual(["ws1", CHAT_CONTAINER, "ws2"]);
    expect(store().groups).toEqual([CHAT_CONTAINER, "ws2"]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });

  test("anchor 不在屏上时拒绝(落点必须是屏上的组)", () => {
    store().openContainer("ws1");
    store().openContainer("ws2");
    expect(store().splitContainerBeside("ws2", "ws1", "right")).toBe(false);
  });

  test("可见列总数受 MAX_PANES 约束(二级窗格一并计入)", () => {
    store().openContainer("ws2");
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c3");
    store().splitConversation("ws1", "c2", 1);
    store().splitConversation("ws1", "c3", 2);
    // ws1 自己已占满 3 列
    expect(panes("ws1")).toHaveLength(MAX_PANES);
    expect(store().groups).toEqual(["ws1"]);
    expect(store().canSplitContainer("ws2")).toBe(false);
    expect(store().splitContainerBeside("ws2", "ws1", "right")).toBe(false);
    // 收掉一列后放得下
    store().closeConversation("ws1", "c3");
    expect(store().canSplitContainer("ws2")).toBe(true);
    expect(store().splitContainerBeside("ws2", "ws1", "right")).toBe(true);
    expect(store().groups).toEqual(["ws1", "ws2"]);
  });

  test("分栏中二级再分栏受总列数约束", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    // 已占 2 列(chat 1 + ws1 1),ws1 内再分一栏 = 3 列,恰好到顶
    expect(store().splitConversation("ws1", "c2", 1)).toBe(true);
    expect(flattenColumns(store().groups, store().panes)).toHaveLength(MAX_PANES);
    // 再分就超了
    store().openConversation("ws1", "c3");
    expect(store().splitConversation("ws1", "c3", 1)).toBe(false);
  });

  test("mergeContainer 退出分栏、回到标签栏;唯一组时拒绝", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    expect(store().mergeContainer("ws1")).toBe(true);
    expect(store().groups).toEqual([CHAT_CONTAINER]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
    // 标签仍开着(合并 ≠ 关闭),二层状态保留
    expect(store().openTabs).toContain("ws1");
    expect(panes("ws1")[0]!.tabs).toEqual(["c1"]);
    expect(store().mergeContainer(CHAT_CONTAINER)).toBe(false);
  });

  test("已在屏上的容器再拆 = 横移成独立组(调用方先 merge 再 split)", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    // [chat, ws1],把 chat 挪到 ws1 右侧:先脱离原组,再落到右侧
    expect(store().mergeContainer(CHAT_CONTAINER)).toBe(true);
    expect(store().splitContainerBeside(CHAT_CONTAINER, "ws1", "right")).toBe(true);
    expect(store().groups).toEqual(["ws1", CHAT_CONTAINER]);
    expect(store().activeTab).toBe(CHAT_CONTAINER);
  });

  test("激活未分栏容器 → 接替焦点组席位,其余组留着", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws2", "b1");
    store().openConversation("ws1", "c1");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    // 分组 [chat, ws1],聚焦 chat;激活 ws2 → ws2 顶掉 chat 的席位,ws1 留下
    expect(store().activeTab).toBe(CHAT_CONTAINER);
    store().activateContainer("ws2");
    expect(store().groups).toEqual(["ws2", "ws1"]);
    expect(store().activeTab).toBe("ws2");
    expect(store().openTabs).toContain(CHAT_CONTAINER);
  });

  test("关闭分栏中的容器标签 → 该组消失,焦点落到剩余组", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    store().closeContainer(CHAT_CONTAINER);
    expect(store().groups).toEqual(["ws1"]);
    expect(store().activeTab).toBe("ws1");
  });

  test("非焦点列关闭会话不返回导航目标(路由只跟焦点列)", () => {
    store().openConversation("ws1", "c1");
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation(CHAT_CONTAINER, "a2");
    store().splitContainerBeside("ws1", CHAT_CONTAINER, "right");
    // 聚焦在 ws1;关掉 chat 组里的激活会话
    expect(store().activeTab).toBe("ws1");
    expect(store().closeConversation(CHAT_CONTAINER, "a2")).toBeUndefined();
    expect(panes(CHAT_CONTAINER)[0]!.active).toBe("a1");
  });

  test("focusPane 跨容器把焦点交给目标列", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    expect(store().activeTab).toBe(CHAT_CONTAINER);
    expect(store().focusPane("ws1", 0)).toBe("c1");
    expect(store().activeTab).toBe("ws1");
  });

  test("flattenColumns 摊平次序 = groups × 容器内窗格", () => {
    store().openConversation(CHAT_CONTAINER, "a1");
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().splitContainerBeside(CHAT_CONTAINER, "ws1", "left");
    store().splitConversation("ws1", "c2", 1);
    const columns = flattenColumns(store().groups, store().panes);
    expect(columns.map((column) => [column.container, column.paneIndex])).toEqual([
      [CHAT_CONTAINER, 0],
      ["ws1", 0],
      ["ws1", 1],
    ]);
  });

  test("分栏容器无窗格记录时也占一列(兜底空窗格)", () => {
    store().openContainer("ws1");
    const columns = flattenColumns(["ws1"], {});
    expect(columns).toHaveLength(1);
    expect(columns[0]!.pane.tabs).toEqual([]);
  });
});

// 存量用户的布局要能无损升级:这条路径出错等于开机丢标签/丢工作区。
describe("持久化自愈与迁移", () => {
  test("v1(conversationTabs)→ 单窗格 + 单容器独占", () => {
    const parsed = sanitizePersistedTabs({
      openTabs: [CHAT_CONTAINER, "ws1"],
      activeTab: "ws1",
      conversationTabs: { ws1: ["c1", "c2", "c1"] },
      activeConversation: { ws1: "c2" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.groups).toEqual(["ws1"]);
    expect(parsed!.panes.ws1).toEqual([{ tabs: ["c1", "c2"], active: "c2" }]);
  });

  test("v2(无布局字段)→ 激活容器独占,不擅自分栏", () => {
    const parsed = sanitizePersistedTabs({
      openTabs: [CHAT_CONTAINER, "ws1"],
      activeTab: CHAT_CONTAINER,
      panes: { ws1: [{ tabs: ["c1"], active: "c1" }] },
      focusedPane: { ws1: 0 },
    });
    expect(parsed!.groups).toEqual([CHAT_CONTAINER]);
    expect(parsed!.activeTab).toBe(CHAT_CONTAINER);
  });

  test("v3(layout 字段)→ v4(groups):语义相同,直接承接", () => {
    const parsed = sanitizePersistedTabs({
      openTabs: [CHAT_CONTAINER, "ws1"],
      layout: [CHAT_CONTAINER, "ws1"],
      activeTab: "ws1",
      panes: {},
      focusedPane: {},
    });
    expect(parsed!.groups).toEqual([CHAT_CONTAINER, "ws1"]);
    expect(parsed!.activeTab).toBe("ws1");
  });

  test("v4 恢复时守住可见列上限:装不下的容器被挤出分栏", () => {
    const parsed = sanitizePersistedTabs({
      openTabs: [CHAT_CONTAINER, "ws1"],
      groups: [CHAT_CONTAINER, "ws1"],
      activeTab: CHAT_CONTAINER,
      panes: {
        ws1: [
          { tabs: ["c1"], active: "c1" },
          { tabs: ["c2"], active: "c2" },
          { tabs: ["c3"], active: "c3" },
        ],
      },
      focusedPane: {},
    });
    // chat(1 列) + ws1(3 列) = 4 > MAX_PANES,ws1 被挤出
    expect(parsed!.groups).toEqual([CHAT_CONTAINER]);
    expect(flattenColumns(parsed!.groups, parsed!.panes).length).toBeLessThanOrEqual(MAX_PANES);
  });

  test("groups 里的未打开容器与重复项被剔除;activeTab 落回组内", () => {
    const parsed = sanitizePersistedTabs({
      openTabs: [CHAT_CONTAINER, "ws1"],
      groups: ["ws1", "ws1", "ghost"],
      activeTab: "ghost",
      panes: {},
      focusedPane: {},
    });
    expect(parsed!.groups).toEqual(["ws1"]);
    expect(parsed!.activeTab).toBe("ws1");
  });

  test("openTabs 缺失/全非法 → 整份数据作废(交由默认态兜底)", () => {
    expect(sanitizePersistedTabs({ groups: ["ws1"] })).toBeNull();
    expect(sanitizePersistedTabs(null)).toBeNull();
  });
});
