// stores/compress-store.ts — 压缩任务的会话级全局状态(内测反馈:切页回来"过程条消失")
// 压缩是长任务,生命周期不应绑定路由组件:组件卸载丢 useState/useRef,回来后互斥失效
// (可并发第二个压缩)、取消句柄丢失。按 conversationId 键控存 AbortController:
// SPA 内跨路由存活;显式取消仍可用;busy 互斥跨页面正确。
// F5 整页刷新时 fetch 断开 → 服务端 request.signal 中止压缩,状态一致地归零,无残留。
import { create } from "zustand";

interface CompressStoreState {
  byConversation: Record<string, AbortController>;
  begin: (conversationId: string, controller: AbortController) => void;
  end: (conversationId: string) => void;
  /** 用户显式取消(压缩框取消键)。 */
  cancel: (conversationId: string) => void;
}

export const useCompressStore = create<CompressStoreState>((set, get) => ({
  byConversation: {},
  begin: (conversationId, controller) =>
    set((state) => ({ byConversation: { ...state.byConversation, [conversationId]: controller } })),
  end: (conversationId) =>
    set((state) => {
      const next = { ...state.byConversation };
      delete next[conversationId];
      return { byConversation: next };
    }),
  cancel: (conversationId) => {
    get().byConversation[conversationId]?.abort();
  },
}));

/** 窄选择器:仅当前会话压缩态跳变才重渲染。 */
export function useConversationCompressing(conversationId: string | null): boolean {
  return useCompressStore((state) => Boolean(conversationId && state.byConversation[conversationId]));
}
