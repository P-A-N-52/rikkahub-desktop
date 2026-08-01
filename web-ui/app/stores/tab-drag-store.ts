import { create } from "zustand";

// J 轮拖拽分栏的瞬时状态:HTML5 DnD 的 dataTransfer 在 dragover 阶段读不到内容
// (安全限制),拖拽中的会话 id 放这里,供各窗格的 drop 判定区显示高亮并执行分栏/移动。
interface TabDragState {
  draggingId: string | null;
  setDragging: (id: string | null) => void;
}

export const useTabDragStore = create<TabDragState>((set) => ({
  draggingId: null,
  setDragging: (id) => set({ draggingId: id }),
}));
