import { useTranslation } from "react-i18next";

// 压缩边界分割线:把模型的记忆边界外显——线上的会话对模型只剩摘要,线下才是
// 逐字可见的原文。位置判定见 lib/compaction.ts(工作区切点上方/对话模式摘要下方)。
export function CompactionDivider() {
  const { t } = useTranslation("page");
  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 text-muted-foreground text-xs"
      role="separator"
      aria-label={t("conversations.compaction_divider")}
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 select-none">{t("conversations.compaction_divider")}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
