import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bug, Loader2, RefreshCw } from "lucide-react";

import { fetchStartupStatus, onStartupPending, type StartupStatusInfo } from "~/services/api";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { CopyButton } from "~/components/ui/copy-button";
import { openExternal } from "~/lib/external-link";

// R1-1:服务端"先绑端口、迁移后置"期间 /api 一律 503,api.ts 探明未就绪后广播事件,
// 本组件整页遮罩展示迁移进度(阶段 + 计数),每秒轮询状态端点,就绪后整页 reload。
// 引导失败(failed)时服务端不退进程,这里把原因呈现给用户——release 壳下没有控制台,
// 这是用户唯一能看到真实原因的地方。
// 域11-1:failed 态加三个行动项——重试(整页 reload 重跑 bootstrap)、复制错误信息、
// GitHub issue 反馈链接。保持"展示真实原因"的优点。
export function StartupGate() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<StartupStatusInfo | null>(null);

  React.useEffect(() => {
    return onStartupPending(() => setOpen(true));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      const next = await fetchStartupStatus();
      if (cancelled || !next) return;
      setStatus(next);
      if (next.ready) window.location.reload();
    };
    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const failed = status?.failed === true;
  const phaseKey = (status?.phase ?? "starting").replace(/-/g, "_");
  const hasProgress = (status?.total ?? 0) > 0;
  const errorText = status?.error ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{failed ? t("startup_gate.failed_title") : t("startup_gate.title")}</CardTitle>
          <CardDescription>
            {failed ? t("startup_gate.failed_description") : t("startup_gate.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {failed ? (
            <div className="space-y-3">
              <p className="break-all text-sm text-destructive">{errorText}</p>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>
                {t(`startup_gate.phase.${phaseKey}`, { defaultValue: t("startup_gate.phase.starting") })}
                {hasProgress ? ` · ${status!.current} / ${status!.total}` : null}
              </span>
            </div>
          )}
        </CardContent>
        {failed ? (
          <CardFooter className="flex-col items-stretch gap-2">
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => window.location.reload()}>
                <RefreshCw className="size-4" />
                {t("startup_gate.retry")}
              </Button>
              <CopyButton
                text={errorText}
                label={t("startup_gate.copy_error")}
                copiedLabel={t("startup_gate.copied")}
                className="h-9 border border-input px-3"
              />
            </div>
            <Button
              variant="outline"
              onClick={() =>
                void openExternal("https://github.com/yuh-G/rikkahub-desktop/issues/new")
              }
            >
              <Bug className="size-4" />
              {t("startup_gate.report_issue")}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
