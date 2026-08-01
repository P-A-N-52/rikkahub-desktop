import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { extractErrorMessage } from "~/lib/error";
import api from "~/services/api";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 容器创建流(工作区 M2-4,方案 §3.1/§3.3):
// - 打开现有文件夹:系统目录选择器(Tauri dialog 插件;浏览器/远程访问退化为手输路径),
//   服务端 validateFolderRoot 做安全准入(存在性/系统目录黑名单/dataDir 嵌套)。
// - 信任门(移植 pi project-trust):folder 型创建后必须显式授权——明示 AI 将能读写
//   该目录并执行命令,列出真实路径;确认写 trustedAt,取消则删除刚建的记录(不留
//   未信任的悬空工作区)。managed 型无信任门(创建即信任)。

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function CreateFolderWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功(尚未信任)。调用方接力信任门。 */
  onCreated: (workspace: WorkspaceDto) => void;
}) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [root, setRoot] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [tauri] = React.useState(isTauri);

  React.useEffect(() => {
    if (open) setRoot("");
  }, [open]);

  const browse = async () => {
    try {
      const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
      const picked = await openPicker({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) setRoot(picked);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.pick_failed")));
    }
  };

  const submit = async () => {
    const trimmed = root.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>("workspaces", { type: "folder", root: trimmed });
      await refresh();
      onOpenChange(false);
      onCreated(res.workspace);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspace.create.folder")}</DialogTitle>
          <DialogDescription>{t("workspace.create.folder_dialog_desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            placeholder={t("workspace.create.folder_path_placeholder")}
            className="flex-1 font-mono text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {tauri ? (
            <Button type="button" variant="outline" onClick={() => void browse()}>
              <FolderOpen className="mr-1.5 size-4" />
              {t("workspace.create.browse")}
            </Button>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("workspace.create.cancel")}
          </Button>
          <Button type="button" disabled={!root.trim() || submitting} onClick={() => void submit()}>
            {t("workspace.create.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceTrustDialog({
  workspace,
  onOpenChange,
  onTrusted,
  onDeclinedDelete,
}: {
  workspace: WorkspaceDto | null;
  onOpenChange: (open: boolean) => void;
  onTrusted: (workspace: WorkspaceDto) => void;
  /** 拒绝授权时是否删除该工作区记录(创建流=true;重开已有工作区=false,仅关门)。 */
  onDeclinedDelete: boolean;
}) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [busy, setBusy] = React.useState(false);

  const trust = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}/trust`);
      await refresh();
      onOpenChange(false);
      onTrusted(res.workspace);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.trust.failed")));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      if (onDeclinedDelete) {
        await api.delete(`workspaces/${workspace.id}`, { parseJson: () => ({}) });
        await refresh();
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.trust.failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={workspace !== null} onOpenChange={(next) => !busy && !next && void decline()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-500" />
            {t("workspace.trust.title")}
          </DialogTitle>
          <DialogDescription>{t("workspace.trust.description")}</DialogDescription>
        </DialogHeader>
        <div className="break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">{workspace?.root}</div>
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>{t("workspace.trust.point_rw")}</li>
          <li>{t("workspace.trust.point_shell")}</li>
          <li>{t("workspace.trust.point_revoke")}</li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decline()}>
            {t("workspace.trust.decline")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void trust()}>
            {t("workspace.trust.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
