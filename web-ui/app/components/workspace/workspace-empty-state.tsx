import { useTranslation } from "react-i18next";
import { FolderGit2, FolderOpen } from "lucide-react";

import { EmptyGreeting } from "~/components/empty-greeting";
import { Button } from "~/components/ui/button";
import type { WorkspaceDto } from "~/types";

// 工作区容器首屏空态(M3-6;前端重构A3 复刻 NewMax 首页):顶部工作区上下文胶囊 +
// 时段问候大标题 + 示例提示词 chip(点击即填入输入框)。
// folder 型的信任门已在创建流完成首次引导,这里不再二次打扰。

const EXAMPLE_KEYS = ["example_1", "example_2", "example_3"] as const;

export function WorkspaceEmptyState({
  workspace,
  onPrompt,
}: {
  workspace: WorkspaceDto;
  onPrompt: (text: string) => void;
}) {
  const { t } = useTranslation("page");
  const Icon = workspace.type === "folder" ? FolderOpen : FolderGit2;

  return (
    <div className="mb-6 text-center">
      {/* 工作区上下文胶囊:名称 + 类型说明(folder 型 hover 展示真实路径),
          对应 NewMax 首页大标题上方的提示胶囊位。 */}
      <div className="mb-4 flex justify-center">
        <span
          className="inline-flex max-w-md items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground"
          title={workspace.type === "folder" && workspace.root ? workspace.root : undefined}
        >
          <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate font-medium text-foreground/80">{workspace.name}</span>
          <span className="shrink-0">
            {workspace.type === "folder"
              ? t("workspace.empty.folder_intro")
              : t("workspace.empty.managed_intro")}
          </span>
        </span>
      </div>
      <EmptyGreeting />
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {EXAMPLE_KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto rounded-full px-3 py-1.5 font-normal text-muted-foreground text-xs hover:text-foreground"
            onClick={() => onPrompt(t(`workspace.empty.${key}`))}
          >
            {t(`workspace.empty.${key}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
