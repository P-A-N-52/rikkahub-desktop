// 双层标签页状态机(M2-1;J 轮窗格分栏)不变量:openTabs 非空/无重复;activeTab ∈ openTabs;
// 每容器 1..MAX_PANES 个窗格,同会话跨窗格去重,多窗格下空窗格即收起;
// 关闭=收起(二层状态保留);工作区删除后标签自愈回落。
import { beforeEach, describe, expect, test } from "bun:test";

import { CHAT_CONTAINER, MAX_PANES, useContainerTabsStore } from "./container-tabs-store";

function reset() {
  useContainerTabsStore.setState({
    openTabs: [CHAT_CONTAINER],
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

  test("reorderContainer 边界钳制", () => {
    store().openContainer("ws1");
    store().openContainer("ws2");
    store().reorderContainer("ws2", 0);
    expect(store().openTabs).toEqual(["ws2", CHAT_CONTAINER, "ws1"]);
    store().reorderContainer("ws2", 99);
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws1", "ws2"]);
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
    expect(store().panes.ws1).toBeUndefined();
  });

  test("chat 容器永不被清理", () => {
    store().pruneWorkspaces(new Set());
    expect(store().openTabs).toEqual([CHAT_CONTAINER]);
  });
});
