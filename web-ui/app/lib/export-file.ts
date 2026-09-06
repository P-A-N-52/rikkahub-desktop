// 域10-1(交互审查 4A):导出文件编排层。桌面壳(与后端同机)走后端落盘到 dataDir/exports/,
// 成功 toast 携带"在文件夹中显示"按钮(reveal);浏览器部署维持原下载通道(download*)。
// 两条路径的成功 toast 文案/时长一致,区别只在桌面壳多一个定位 action。

import { toast } from "sonner";

import i18n from "~/i18n";
import { isDesktopShell } from "~/lib/external-link";
import { revealExportFile, saveExportFile } from "~/services/api";

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`message:chat_message.${key}`, params ?? {});
}

export interface ExportFileResult {
  /** 桌面壳为落盘后的实际文件名(可能带冲突序号);浏览器即请求的文件名。 */
  filename: string;
  /** 桌面壳的绝对路径;浏览器为 null(下载目录不可知)。 */
  path: string | null;
}

function toastSuccess(filename: string, path: string | null): void {
  toast.success(t("export_success"), {
    description: t("export_success_desc", { filename }),
    duration: 7000,
    ...(path
      ? {
          action: {
            label: t("export_show_in_folder"),
            onClick: () => void revealExportFile(path).catch(() => {}),
          },
        }
      : {}),
  });
}

function fallbackDownload(content: string | Blob, filename: string): void {
  const blob = typeof content === "string" ? new Blob([content]) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出文本(Markdown)。桌面壳落盘 + 定位;浏览器下载。 */
export async function exportTextFile(content: string, filename: string): Promise<ExportFileResult> {
  if (isDesktopShell()) {
    const saved = await saveExportFile(filename, content);
    toastSuccess(saved.filename, saved.path);
    return saved;
  }
  fallbackDownload(content, filename);
  toastSuccess(filename, null);
  return { filename, path: null };
}

/** 导出 dataURL(PNG 截图)。桌面壳落盘 + 定位;浏览器下载。 */
export async function exportDataUrlFile(dataUrl: string, filename: string): Promise<ExportFileResult> {
  if (isDesktopShell()) {
    // dataURL 的 base64 部分直接交给后端解码落盘,前端不用再转 Blob。
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const saved = await saveExportFile(filename, base64, "base64");
    toastSuccess(saved.filename, saved.path);
    return saved;
  }
  fallbackDownload(dataUrlToBlob(dataUrl), filename);
  toastSuccess(filename, null);
  return { filename, path: null };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/data:(.*?)(;|$)/)?.[1] ?? "application/octet-stream";
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}
