import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderTree } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useOptionalWorkbench } from "~/components/workbench/workbench-context";
import { cn } from "~/lib/utils";
import { CHAT_CONTAINER, useContainerTabsStore } from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";

/** 文件面板入口(M3-5):仅工作区容器内显示,开关 Workbench 的 workspace-files 面板。 */
export function WorkspaceFilesButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const workbench = useOptionalWorkbench();
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const workspace = useWorkspaceStore((state) =>
    activeTab === CHAT_CONTAINER ? undefined : state.workspaces.find((item) => item.id === activeTab),
  );

  if (!workspace || !workbench) return null;

  const isOpen = workbench.panel?.type === "workspace-files"
    && workbench.panel.payload.workspaceId === workspace.id;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-8 gap-1 rounded-full px-2.5 text-muted-foreground hover:text-foreground",
        isOpen && "text-foreground",
        className,
      )}
      title={t("workbench.files.title")}
      onClick={() => {
        if (isOpen) workbench.closePanel();
        else {
          workbench.openPanel({
            type: "workspace-files",
            title: workspace.name,
            payload: { workspaceId: workspace.id },
          });
        }
      }}
    >
      <FolderTree className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
