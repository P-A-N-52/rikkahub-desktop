// 会话列表排序/合并/刷新契约(FE-P1-3)。列表 UI 的呈现顺序、分页加载更多、
// invalidate 后的头部刷新语义都钉在这里。
import { describe, expect, test } from "bun:test";

import type { ConversationListDto } from "~/types";
import { mergeConversationList, refreshConversationList, sortConversationList } from "~/lib/conversation-list-ops";

function item(id: string, updateAt: number, isPinned = false): ConversationListDto {
  return { id, assistantId: "a1", title: id, isPinned, createAt: 0, updateAt, isGenerating: false };
}

describe("sortConversationList", () => {
  test("置顶优先,同置顶按 updateAt 降序;不修改入参数组", () => {
    const input = [item("old", 1), item("pinned", 2, true), item("new", 9)];
    const sorted = sortConversationList(input);
    expect(sorted.map((c) => c.id)).toEqual(["pinned", "new", "old"]);
    expect(input.map((c) => c.id)).toEqual(["old", "pinned", "new"]);
  });
});

describe("mergeConversationList", () => {
  test("同 id 以 incoming 覆盖,新 id 追加,整体重排", () => {
    const base = [item("a", 5), item("b", 3)];
    const merged = mergeConversationList(base, [item("b", 9), item("c", 7)]);
    expect(merged.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(merged.find((c) => c.id === "b")!.updateAt).toBe(9);
  });
});

describe("refreshConversationList", () => {
  test("incoming 替换前 replaceCount 条,尾部保留但剔除与 incoming 重复的 id", () => {
    const previous = [item("a", 9), item("b", 8), item("c", 7), item("d", 6)];
    // 刷新头两条:a 更新、e 新进;尾部 c/d 保留,但 c 也出现在 incoming 里(位置变动),不得重复
    const refreshed = refreshConversationList(previous, [item("a", 10), item("e", 9.5), item("c", 9.2)], 2);
    expect(refreshed.map((c) => c.id)).toEqual(["a", "e", "c", "d"]);
    expect(refreshed.filter((c) => c.id === "c")).toHaveLength(1);
  });

  test("replaceCount 覆盖全量时等价于整表替换", () => {
    const previous = [item("a", 9), item("b", 8)];
    const refreshed = refreshConversationList(previous, [item("x", 1)], 2);
    expect(refreshed.map((c) => c.id)).toEqual(["x"]);
  });
});
