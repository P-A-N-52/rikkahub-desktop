import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import api from "~/services/api";
import { downloadUpdatePackage } from "~/services/update-download";
import { cn } from "~/lib/utils";
import { canOpenMacUpdate, openMacUpdateDmg } from "~/lib/update-installation";

export type UpdateInfo = {
  current: string;
  latest: string;
  isNewer: boolean;
  isSkipped?: boolean;
  title: string;
  notes: string;
  htmlUrl: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  sha256?: string;
  cachedInstallerPath?: string | null;
  /** 后端运行平台，决定更新包与安装流程。macOS 只打开 DMG，由用户在 Finder 替换应用。 */
  platform?: "win" | "mac" | "linux";
  architecture?: string;
  releaseRepo?: string;
  /** 容器化部署（Docker 等）无法原地更新，前端改为提示 docker pull。 */
  containerized?: boolean;
};

interface UpdateDialogProps {
  info: UpdateInfo;
  open: boolean;
  onClose: () => void;
}

export function UpdateDialog({ info, open, onClose }: UpdateDialogProps) {
  const { t } = useTranslation("common");
  const [downloading, setDownloading] = React.useState(false);
  const [downloadProgress, setDownloadProgress] = React.useState(0);
  const [downloadedBytes, setDownloadedBytes] = React.useState(0);
  const [totalBytes, setTotalBytes] = React.useState(0);
  const [installerPath, setInstallerPath] = React.useState<string | null>(
    info.cachedInstallerPath ?? null,
  );
  const [installerCached, setInstallerCached] = React.useState(!!info.cachedInstallerPath);
  const [installerLaunching, setInstallerLaunching] = React.useState(false);
  const activeDownload = React.useRef<AbortController | null>(null);
  const isMacUpdate = info.platform === "mac";
  const canOpenDmg = canOpenMacUpdate(info.platform);

  const cancelDownload = React.useCallback(() => {
    activeDownload.current?.abort();
    activeDownload.current = null;
    setDownloading(false);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
  }, []);

  React.useEffect(() => () => activeDownload.current?.abort(), []);
  React.useEffect(() => {
    cancelDownload();
    setInstallerPath(info.cachedInstallerPath ?? null);
    setInstallerCached(!!info.cachedInstallerPath);
    setInstallerLaunching(false);
  }, [info.latest, info.fileName, info.downloadUrl, info.cachedInstallerPath, cancelDownload]);
  React.useEffect(() => { if (!open) cancelDownload(); }, [open, cancelDownload]);

  const handleClose = () => {
    cancelDownload();
    onClose();
  };

  const skipThisVersion = async () => {
    try {
      await api.post("update/skip", { version: info.latest });
      toast.success(t("update.skip_success", { version: info.latest }));
    } catch {
      toast.error(t("update.op_failed"));
    }
    onClose();
  };

  const downloadUpdate = async () => {
    if (!info.downloadUrl) return;
    activeDownload.current?.abort();
    const controller = new AbortController();
    activeDownload.current = controller;
    const isCurrent = () => activeDownload.current === controller && !controller.signal.aborted;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      const result = await downloadUpdatePackage({
        url: info.downloadUrl, fileName: info.fileName, version: info.latest, size: info.size, sha256: info.sha256,
      }, {
        signal: controller.signal,
        incompleteMessage: t("update.download_incomplete"),
        failedMessage: t("update.download_failed"),
        onProgress: (progress) => {
          if (!isCurrent()) return;
          setTotalBytes(progress.total);
          setDownloadedBytes(progress.loaded);
          setDownloadProgress(progress.percent);
        },
      });
      if (!isCurrent()) return;
      setInstallerPath(result.path);
      setInstallerCached(false);
      setDownloadProgress(100);
      toast.success(t("update.download_done"));
    } catch (err) {
      if (!isCurrent()) return;
      toast.error(err instanceof Error ? err.message : t("update.download_failed"));
    } finally {
      if (activeDownload.current === controller) {
        activeDownload.current = null;
        setDownloading(false);
      }
    }
  };

  const openDmg = async () => {
    if (!installerPath || !canOpenDmg) return;
    setInstallerLaunching(true);
    try {
      await openMacUpdateDmg(info.platform, installerPath, info.latest);
      toast.success(t("update.mac_opened"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t("update.mac_open_failed", { message }));
    } finally {
      setInstallerLaunching(false);
    }
  };

  // Windows only: hand the downloaded installer to the Tauri shell, which launches it as a
  // detached NSIS process and then we exit so the installer's "close target app" check passes.
  const launchAndExit = async () => {
    if (!installerPath) return;
    setInstallerLaunching(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("launch_installer", { path: installerPath });
      toast.success(t("update.installer_launched"));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : t("update.installer_launch_failed");
      toast.error(t("update.installer_launch_failed_msg", { message }));
      setInstallerLaunching(false);
    }
  };

  // Linux: the binary was downloaded + chmod'd by the backend. Ask it to atomically swap
  // process.execPath for the new file. The running process keeps serving on the old inode
  // until it exits, so the call returns cleanly; the user then restarts to run the new version.
  const applyUpdate = async () => {
    if (!installerPath) return;
    setInstallerLaunching(true);
    try {
      await api.post("update/apply", { path: installerPath });
      toast.success(t("update.applied_restart"));
      handleClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("update.apply_failed");
      toast.error(message);
      setInstallerLaunching(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{info.isNewer ? t("update.title_new") : t("update.title_latest")}</DialogTitle>
          <DialogDescription>
            {info.isNewer
              ? t("update.desc_new", { current: info.current, latest: info.latest })
              : t("update.desc_latest", { current: info.current, latest: info.latest || t("update.unknown") })}
          </DialogDescription>
        </DialogHeader>
        {info.notes ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t("update.notes")}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {info.notes}
            </pre>
          </div>
        ) : null}
        {info.containerized ? (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
            {t("update.containerized_prefix")}
            <code className="mx-0.5 rounded bg-warning/10 px-1 py-0.5 font-mono">
              docker pull
            </code>
            {t("update.containerized_suffix")}
          </div>
        ) : null}
        {isMacUpdate && info.isNewer && !info.containerized ? (
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            {!info.downloadUrl && !installerPath
              ? t("update.mac_download_unavailable")
              : canOpenDmg ? t("update.mac_instructions") : t("update.mac_desktop_required")}
          </div>
        ) : null}
        {downloading ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{downloadProgress > 0 ? t("update.updating_percent", { percent: downloadProgress }) : t("update.updating")}</span>
              {totalBytes > 0 ? (
                <span className="font-mono">
                  {(downloadedBytes / (1024 * 1024)).toFixed(1)} /{" "}
                  {(totalBytes / (1024 * 1024)).toFixed(1)} MB
                </span>
              ) : downloadedBytes > 0 ? (
                <span className="font-mono">{(downloadedBytes / (1024 * 1024)).toFixed(1)} MB</span>
              ) : null}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full bg-primary transition-all",
                  downloadProgress === 0 && "w-full animate-pulse",
                )}
                style={downloadProgress > 0 ? { width: `${downloadProgress}%` } : undefined}
              />
            </div>
          </div>
        ) : null}
        {installerPath && (!isMacUpdate || canOpenDmg) ? (
          <div className="rounded-md border border-success/30 bg-success/5 p-3 text-xs text-success">
            {info.platform === "linux" ? (
              <>{t("update.linux_ready")}</>
            ) : isMacUpdate ? (
              <>
                {t("update.mac_ready")}
                <code className="ml-1 break-all font-mono">{installerPath}</code>
                <br />
                {t("update.mac_keep_data")}
              </>
            ) : (
              <>
                {installerCached ? t("update.installer_cached") : t("update.installer_downloaded")}
                <code className="ml-1 break-all font-mono">{installerPath}</code>
                <br />
                {t("update.installer_keep_data")}
              </>
            )}
          </div>
        ) : null}
        <DialogFooter>
          {!info.isNewer ? (
            <Button type="button" onClick={handleClose}>
              {t("update.got_it")}
            </Button>
          ) : info.containerized ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
              >
                {t("update.skip_version")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => info.htmlUrl && window.open(info.htmlUrl, "_blank")}
              >
                {t("update.view_release")}
              </Button>
              <Button type="button" onClick={handleClose}>
                {t("update.later")}
              </Button>
            </>
          ) : !info.downloadUrl || (isMacUpdate && !canOpenDmg) ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
              >
                {t("update.skip_version")}
              </Button>
              <Button
                type="button"
                onClick={() => info.htmlUrl && window.open(info.htmlUrl, "_blank")}
              >
                {t("update.goto_github")}
              </Button>
            </>
          ) : !installerPath ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
                disabled={downloading}
              >
                {t("update.skip_version")}
              </Button>
              <Button type="button" variant="outline" onClick={downloading ? cancelDownload : handleClose}>
                {downloading ? t("update.cancel_download") : t("update.later")}
              </Button>
              <Button
                type="button"
                onClick={() => void downloadUpdate()}
                disabled={downloading || !info.downloadUrl}
              >
                {downloading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                {downloading ? t("update.updating") : isMacUpdate ? t("update.mac_download") : t("update.update_now")}
              </Button>
            </>
          ) : isMacUpdate ? (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t("update.update_later")}
              </Button>
              <Button type="button" onClick={() => void openDmg()} disabled={installerLaunching}>
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("update.mac_open_dmg")}
              </Button>
            </>
          ) : info.platform === "linux" ? (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t("update.restart_later")}
              </Button>
              <Button
                type="button"
                onClick={() => void applyUpdate()}
                disabled={installerLaunching}
              >
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("update.apply_restart")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t("update.update_later")}
              </Button>
              <Button
                type="button"
                onClick={() => void launchAndExit()}
                disabled={installerLaunching}
              >
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("update.restart_update")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
