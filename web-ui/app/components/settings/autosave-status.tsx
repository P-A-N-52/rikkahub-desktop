// components/settings/autosave-status.tsx — 自动保存三态状态行(域7-1,交互审查 3A)。
//
// 病史:设置各分区此前是二态 span("自动保存中"/"已自动保存"),失败静默——保存挂了
// 用户看到的仍是"已自动保存"(假已保存)。本组件统一三态:
//   pending/saving → "正在自动保存…"(muted + spinner)
//   saved          → "已自动保存"(muted)
//   failed         → "保存失败,点击重试"(destructive 红字按钮,点击 saveNow)
// 数据源是 useAutosaveDraft 返回的 status(状态机见 hook 文件头);所有设置分区
// 一个模式,不再散落二态 span。
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AutosaveStatus } from "~/hooks/use-autosave-draft";
import { cn } from "~/lib/utils";

export function AutosaveStatusRow({
  status,
  onRetry,
  className,
}: {
  status: AutosaveStatus;
  /** 失败态点击重试(通常 = autosave.saveNow)。 */
  onRetry?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();

  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "flex items-center px-2 text-destructive text-xs transition-colors hover:underline",
          className,
        )}
      >
        {t("settings:common.autosave_failed_retry")}
      </button>
    );
  }

  const busy = status === "pending" || status === "saving";
  return (
    <div
      className={cn("flex items-center gap-1.5 px-2 text-muted-foreground text-xs", className)}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {busy ? t("settings:common.autosaving") : t("settings:common.autosaved")}
    </div>
  );
}
