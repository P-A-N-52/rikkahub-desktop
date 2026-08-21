import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { extractErrorMessage } from "~/lib/error";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useWorkspaceStore } from "~/stores/workspace-store";

// 文件面板(M3-5,方案 §4.4):Workbench 面板类型 "workspace-files"。
// 懒加载文件树 + 单击预览(文本/图片) + 右键(重命名/删除/在资源管理器中显示)
// + 顶部工作区路径面包屑 + 拖文件进聊天输入框(dataTransfer text/plain = 相对路径,
// textarea 原生接受 text/plain drop,无需输入框侧改造)。
// 数据 100% 即取即用,不持久化;boundary 校验在服务端,前端只做展示。

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

type FilePreview =
  | { kind: "text"; text: string; truncated: boolean; size: number }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "binary"; size: number };

// AGENTS.md 编辑入口(P4,方案 §3.3):读写"pi 实际加载的项目上下文文件"
// (AGENTS.md/CLAUDE.md 候选,后端裁定);无则以默认模板引导创建。
interface AgentsFileState {
  fileName: string;
  exists: boolean;
  content: string;
  template: string;
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export function WorkspaceFilesPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId));
  // 目录 → 子条目;undefined=未加载。version 用于强刷(重命名/删除后重载受影响目录)。
  const [children, setChildren] = React.useState<Record<string, FileEntry[] | undefined>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]));
  const [preview, setPreview] = React.useState<{ path: string; data: FilePreview | null } | null>(null);
  const [renameTarget, setRenameTarget] = React.useState<{ path: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ path: string; isDir: boolean } | null>(null);
  // null=关闭;{data:null}=加载中。draft 独立受控,取消不落盘。
  const [agentsDialog, setAgentsDialog] = React.useState<{ data: AgentsFileState | null } | null>(null);
  const [agentsDraft, setAgentsDraft] = React.useState("");
  const [agentsSaving, setAgentsSaving] = React.useState(false);

  const loadDir = React.useCallback(
    async (relPath: string) => {
      try {
        const res = await api.get<{ entries: FileEntry[] }>(
          `workspaces/${workspaceId}/files?path=${encodeURIComponent(relPath)}`,
        );
        setChildren((prev) => ({ ...prev, [relPath]: res.entries }));
      } catch (err) {
        toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      }
    },
    [workspaceId],
  );

  React.useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const toggleDir = (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else {
        next.add(relPath);
        if (children[relPath] === undefined) void loadDir(relPath);
      }
      return next;
    });
  };

  const openPreview = async (relPath: string) => {
    setPreview({ path: relPath, data: null });
    try {
      const res = await api.get<{ preview: FilePreview }>(
        `workspaces/${workspaceId}/files/content?path=${encodeURIComponent(relPath)}`,
      );
      setPreview((current) => (current?.path === relPath ? { path: relPath, data: res.preview } : current));
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      setPreview(null);
    }
  };

  const reloadParentOf = (relPath: string) => {
    const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    void loadDir(parent);
  };

  const doRename = async (newName: string) => {
    if (!renameTarget || !newName.trim() || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    try {
      await api.post(`workspaces/${workspaceId}/files/rename`, { path: renameTarget.path, newName: newName.trim() });
      reloadParentOf(renameTarget.path);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setRenameTarget(null);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`workspaces/${workspaceId}/files?path=${encodeURIComponent(deleteTarget.path)}`);
      reloadParentOf(deleteTarget.path);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setDeleteTarget(null);
    }
  };

  const doReveal = async (relPath: string) => {
    try {
      await api.post(`workspaces/${workspaceId}/files/reveal`, { path: relPath });
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    }
  };

  const openAgentsDialog = async () => {
    setAgentsDialog({ data: null });
    try {
      const res = await api.get<{ agentsFile: AgentsFileState }>(`workspaces/${workspaceId}/agents-file`);
      setAgentsDialog((current) => (current ? { data: res.agentsFile } : current));
      setAgentsDraft(res.agentsFile.exists ? res.agentsFile.content : res.agentsFile.template);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      setAgentsDialog(null);
    }
  };

  const saveAgentsFile = async () => {
    if (!agentsDialog?.data) return;
    setAgentsSaving(true);
    try {
      const wasNew = !agentsDialog.data.exists;
      await api.put(`workspaces/${workspaceId}/agents-file`, { content: agentsDraft });
      toast.success(t("workbench.files.agents_saved"));
      setAgentsDialog(null);
      if (wasNew) void loadDir(""); // 新建文件后根目录列表出现 AGENTS.md
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setAgentsSaving(false);
    }
  };

  const renderEntries = (relPath: string, depth: number): React.ReactNode => {
    const entries = children[relPath];
    if (entries === undefined) {
      return (
        <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs" style={{ paddingLeft: depth * 14 + 8 }}>
          <Loader2 className="size-3 animate-spin" />
        </div>
      );
    }
    if (entries.length === 0 && relPath === "") {
      return <div className="px-3 py-6 text-center text-muted-foreground text-xs">{t("workbench.files.empty_dir")}</div>;
    }
    return entries.map((entry) => {
      const entryPath = joinRel(relPath, entry.name);
      const isOpen = entry.type === "dir" && expanded.has(entryPath);
      return (
        <React.Fragment key={entryPath}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  // 拖进聊天输入框=引用相对路径(textarea 原生插入 text/plain)
                  event.dataTransfer.setData("text/plain", entryPath);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => (entry.type === "dir" ? toggleDir(entryPath) : void openPreview(entryPath))}
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                style={{ paddingLeft: depth * 14 + 8 }}
              >
                {entry.type === "dir" ? (
                  <>
                    {isOpen ? <ChevronDown className="size-3 shrink-0 opacity-60" /> : <ChevronRight className="size-3 shrink-0 opacity-60" />}
                    {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" /> : <Folder className="size-3.5 shrink-0 text-amber-500" />}
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    {IMAGE_EXT_RE.test(entry.name)
                      ? <FileImage className="size-3.5 shrink-0 text-muted-foreground" />
                      : <File className="size-3.5 shrink-0 text-muted-foreground" />}
                  </>
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.type === "file" ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatSize(entry.size)}</span>
                ) : null}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setRenameTarget({ path: entryPath, name: entry.name })}>
                {t("workbench.files.rename")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void doReveal(entryPath)}>
                {t("workbench.files.reveal")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => setDeleteTarget({ path: entryPath, isDir: entry.type === "dir" })}>
                {t("workbench.files.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {isOpen ? renderEntries(entryPath, depth + 1) : null}
        </React.Fragment>
      );
    });
  };

  if (!workspace) {
    return <div className="p-4 text-muted-foreground text-sm">{t("workbench.files.workspace_missing")}</div>;
  }

  if (preview) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <Button type="button" size="icon-sm" variant="ghost" onClick={() => setPreview(null)} aria-label={t("workbench.files.back")}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={preview.path}>{preview.path}</span>
          {preview.data ? <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(preview.data.size)}</span> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {preview.data === null ? (
            <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : preview.data.kind === "image" ? (
            <div className="flex h-full items-center justify-center p-4">
              <img src={preview.data.dataUrl} alt={preview.path} className="max-h-full max-w-full object-contain" />
            </div>
          ) : preview.data.kind === "text" ? (
            <>
              {preview.data.truncated ? (
                <div className="border-b bg-amber-500/10 px-3 py-1.5 text-amber-600 text-xs dark:text-amber-400">
                  {t("workbench.files.preview_truncated")}
                </div>
              ) : null}
              <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5">{preview.data.text}</pre>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
              {t("workbench.files.binary_preview", { size: formatSize(preview.data.size) })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={workspace.root}>
          {workspace.root}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("workbench.files.agents_edit")}
          title={t("workbench.files.agents_edit")}
          onClick={() => void openAgentsDialog()}
        >
          <BookOpenText className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("workbench.files.refresh")}
          onClick={() => {
            setChildren({});
            setExpanded(new Set([""]));
            void loadDir("");
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">{renderEntries("", 0)}</div>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.rename")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("name");
              void doRename(String(value ?? ""));
            }}
          >
            <Input name="name" defaultValue={renameTarget?.name ?? ""} autoFocus />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenameTarget(null)}>{t("workbench.files.cancel")}</Button>
              <Button type="submit">{t("workbench.files.confirm")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={agentsDialog !== null} onOpenChange={(open) => { if (!open) setAgentsDialog(null); }}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("workbench.files.agents_dialog_title", { name: agentsDialog?.data?.fileName ?? "AGENTS.md" })}
            </DialogTitle>
            <DialogDescription>
              {agentsDialog?.data && !agentsDialog.data.exists
                ? t("workbench.files.agents_dialog_create_hint")
                : t("workbench.files.agents_dialog_edit_hint")}
            </DialogDescription>
          </DialogHeader>
          {agentsDialog?.data === null ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Textarea
              value={agentsDraft}
              onChange={(event) => setAgentsDraft(event.target.value)}
              spellCheck={false}
              className="min-h-64 flex-1 resize-none font-mono text-xs leading-5"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAgentsDialog(null)}>
              {t("workbench.files.cancel")}
            </Button>
            <Button type="button" disabled={agentsSaving || !agentsDialog?.data} onClick={() => void saveAgentsFile()}>
              {agentsSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("workbench.files.agents_save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.delete")}</DialogTitle>
            <DialogDescription>
              {t(deleteTarget?.isDir ? "workbench.files.delete_dir_confirm" : "workbench.files.delete_file_confirm", {
                name: deleteTarget?.path ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)}>{t("workbench.files.cancel")}</Button>
            <Button type="button" variant="destructive" onClick={() => void doDelete()}>{t("workbench.files.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
