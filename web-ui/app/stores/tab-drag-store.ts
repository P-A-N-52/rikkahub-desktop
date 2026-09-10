import { create } from "zustand";

import type { ContainerKey } from "~/stores/container-tabs-store";

// 标签拖拽的瞬时载荷:HTML5 DnD 的 dataTransfer 在 dragover 阶段读不到内容(安全限制),
// 于是把"正在拖谁"放内存 store,供各列的 drop 判定区决定高亮与落点动作。
// 两级标签共用一条通道(L 轮):二级 = 会话标签(带源容器,跨容器落点据此拒绝);
// 一级 = 容器整块(带着自己的会话标签一起并排)。
export type TabDragPayload =
  | { kind: "conversation"; conversationId: string; container: ContainerKey }
  | { kind: "container"; container: ContainerKey };

interface TabDragState {
  dragging: TabDragPayload | null;
  setDragging: (payload: TabDragPayload | null) => void;
}

export const useTabDragStore = create<TabDragState>((set) => ({
  dragging: null,
  setDragging: (payload) => set({ dragging: payload }),
}));
