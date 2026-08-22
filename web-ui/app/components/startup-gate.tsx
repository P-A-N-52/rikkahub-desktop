import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { fetchStartupStatus, onStartupPending, type StartupStatusInfo } from "~/services/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

// R1-1:服务端"先绑端口、迁移后置"期间 /api 一律 503,api.ts 探明未就绪后广播事件,
// 本组件整页遮罩展示迁移进度(阶段 + 计数),每秒轮询状态端点,就绪后整页 reload。
// 引导失败(failed)时服务端不退进程,这里把原因呈现给用户——release 壳下没有控制台,
// 这是用户唯一能看到真实原因的地方。
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
            <p className="break-all text-sm text-destructive">{status?.error}</p>
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
      </Card>
    </div>
  );
}
