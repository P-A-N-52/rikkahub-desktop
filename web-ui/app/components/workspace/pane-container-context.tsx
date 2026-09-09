import * as React from "react";

import { CHAT_CONTAINER, useContainerTabsStore, type ContainerKey } from "~/stores/container-tabs-store";

// 列所属容器的读取通道(K 轮一级并排)。
// 并排后同屏存在多个容器,输入区里的"工作区文件/权限档位"等控件不能再读全局 activeTab
// ——非聚焦列会显示邻列工作区的状态。由窗格视图在自己的子树注入本列容器,控件按上下文
// 取值;上下文缺失(设置页等非分栏场景)时回落全局激活容器,行为与并排前一致。
const PaneContainerContext = React.createContext<ContainerKey | null>(null);

export function PaneContainerProvider({
  container,
  children,
}: {
  container: ContainerKey;
  children: React.ReactNode;
}) {
  return <PaneContainerContext.Provider value={container}>{children}</PaneContainerContext.Provider>;
}

/** 当前所在列的容器键(无上下文时回落全局激活容器)。 */
export function usePaneContainer(): ContainerKey {
  const fromContext = React.useContext(PaneContainerContext);
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  return fromContext ?? activeTab ?? CHAT_CONTAINER;
}
