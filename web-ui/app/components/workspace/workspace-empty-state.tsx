import { useTranslation } from "react-i18next";
import { FolderGit2, FolderOpen } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { WorkspaceDto } from "~/types";

// 工作区容器首屏空态(M3-6,方案 §4.6):延续启动屏品牌元素的克制风格——
// 呼吸动画图标 + 一句话说明 + 示例提示词 chip(点击即填入输入框)。
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
    <div className="mb-4 text-center">
      <div className="mb-4 flex justify-center">
        <div className="[animation:rikkahub-breathe_4s_ease-in-out_infinite]">
          <Icon className="size-14 text-primary" strokeWidth={1.25} />
        </div>
      </div>
      <p className="text-xl font-medium leading-relaxed text-foreground">{workspace.name}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {workspace.type === "folder" ? t("workspace.empty.folder_intro") : t("workspace.empty.managed_intro")}
      </p>
      {workspace.type === "folder" && workspace.root ? (
        <p className="mx-auto mt-1 max-w-md truncate font-mono text-[11px] text-muted-foreground/70" title={workspace.root}>
          {workspace.root}
        </p>
      ) : null}
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
