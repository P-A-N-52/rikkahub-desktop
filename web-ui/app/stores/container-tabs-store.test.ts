// 双层标签页状态机(M2-1)不变量:openTabs 非空/无重复;activeTab ∈ openTabs;
// 关闭=收起(二层状态保留);工作区删除后标签自愈回落。
import { beforeEach, describe, expect, test } from "bun:test";

import { CHAT_CONTAINER, useContainerTabsStore } from "./container-tabs-store";

function reset() {
  useContainerTabsStore.setState({
    openTabs: [CHAT_CONTAINER],
    activeTab: CHAT_CONTAINER,
    conversationTabs: {},
    activeConversation: {},
  });
}

beforeEach(reset);

const store = () => useContainerTabsStore.getState();

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

describe("会话标签", () => {
  test("openConversation 连带打开容器并激活会话", () => {
    store().openConversation("ws1", "c1");
    expect(store().openTabs).toEqual([CHAT_CONTAINER, "ws1"]);
    expect(store().activeTab).toBe("ws1");
    expect(store().conversationTabs.ws1).toEqual(["c1"]);
    expect(store().activeConversation.ws1).toBe("c1");
  });

  test("重复打开同会话不重复建标签", () => {
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c1");
    expect(store().conversationTabs.ws1).toEqual(["c1", "c2"]);
    expect(store().activeConversation.ws1).toBe("c1");
  });

  test("关闭激活会话标签 → 返回应激活的邻居;关闭非激活返回 undefined", () => {
    store().openConversation("ws1", "c1");
    store().openConversation("ws1", "c2");
    store().openConversation("ws1", "c3");
    expect(store().closeConversation("ws1", "c1")).toBeUndefined();
    store().openConversation("ws1", "c2");
    expect(store().closeConversation("ws1", "c2")).toBe("c3");
    expect(store().closeConversation("ws1", "c3")).toBeNull();
    expect(store().conversationTabs.ws1).toEqual([]);
  });

  test("容器收起后二层状态保留,重开恢复", () => {
    store().openConversation("ws1", "c1");
    store().closeContainer("ws1");
    expect(store().conversationTabs.ws1).toEqual(["c1"]);
    store().openContainer("ws1");
    expect(store().activeConversation.ws1).toBe("c1");
  });

  test("forgetConversation 清所有容器中的标签与激活位", () => {
    store().openConversation(CHAT_CONTAINER, "c1");
    store().openConversation("ws1", "c1");
    store().forgetConversation("c1");
    expect(store().conversationTabs[CHAT_CONTAINER]).toEqual([]);
    expect(store().conversationTabs.ws1).toEqual([]);
    expect(store().activeConversation.ws1).toBeNull();
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
    expect(store().conversationTabs.ws1).toBeUndefined();
  });

  test("chat 容器永不被清理", () => {
    store().pruneWorkspaces(new Set());
    expect(store().openTabs).toEqual([CHAT_CONTAINER]);
  });
});
