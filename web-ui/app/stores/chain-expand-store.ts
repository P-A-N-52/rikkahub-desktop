import { create } from "zustand";

// 思维链大卡的用户展开态(会话级内存,刻意不持久化磁盘——重启回默认折叠是合理预期)。
//
// 状态主权修复(用户 2026-09-05 拍板):展开/折叠一旦由用户表态即归用户所有,系统的
// 任何自动行为都无权重置。旧实现把 expanded 放在 ChainOfThought 组件内部 state、
// 渲染 key 挂在易漂移的块序号上——新事件导致块弹出/切链、虚拟化滚动卸载重建,都会
// 无声地把用户展开的大卡打回折叠,打断正在进行的阅读(状态窃取反模式)。
// 现在:key=messageId:块稳定身份(lib/message-grouping.ts thinkingBlockKey),值只由
// 用户点击写入,组件重建后照常读回。
//
// 不做清理:每项一个布尔,量级可忽略;保留意味着用户切走再回来阅读状态仍在。
interface ChainExpandState {
  expandedByKey: Record<string, boolean>;
  setExpanded: (key: string, expanded: boolean) => void;
}

export const useChainExpandStore = create<ChainExpandState>((set) => ({
  expandedByKey: {},
  setExpanded: (key, expanded) =>
    set((state) => ({ expandedByKey: { ...state.expandedByKey, [key]: expanded } })),
}));
