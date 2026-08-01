import { create } from "zustand";

import api from "~/services/api";
import type { WorkspaceDto } from "~/types";

interface WorkspaceStoreState {
  workspaces: WorkspaceDto[];
  /** 首次拉取是否完成(区分"没有工作区"与"还没拉到")。 */
  loaded: boolean;
  refresh: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

/** 工作区列表 store:容器标签栏、创建流、权限档位下拉共用。
 *  权威在服务端;所有 CRUD 走 REST 后调 refresh() 校正,无本地乐观分叉。 */
export const useWorkspaceStore = create<WorkspaceStoreState>((set) => ({
  workspaces: [],
  loaded: false,
  refresh: () => {
    inflight ??= api
      .get<{ workspaces: WorkspaceDto[] }>("workspaces")
      .then((res) => set({ workspaces: res.workspaces, loaded: true }))
      .catch(() => {
        /* 离线/后端重启窗口:保留上次已知列表,下次触发重试 */
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
}));

export function getWorkspaceById(id: string): WorkspaceDto | undefined {
  return useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === id);
}
