import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  FilePen,
  FilePlus2,
  FileText,
  Loader2,
  Maximize2,
  SquareTerminal,
  X,
} from "lucide-react";

import { DetailDrawer } from "~/components/detail-drawer";
import { Button } from "~/components/ui/button";
import { DiffView, parseDiffStats } from "~/components/workspace/diff-view";
import { TerminalOutput } from "~/components/workspace/terminal-output";
import { cn } from "~/lib/utils";
import type { ToolPart as UIToolPart } from "~/types";

// 工作区工具渲染器(M2-3,方案 §4.3)。可见性分层:
// - read(只读侦察)留在思维链折叠组(tool-part.tsx 只借本模块的标题/图标);
// - write/edit/bash(改变世界的动作)由 message-part.tsx 抽出为顶层动作卡(本模块)。
// 渲染 100% 由 part 数据驱动(input/output/metadata.workspace),无前端私有状态——
// 备份互通的两个方向都不降级:PC 存 pi 原样;安卓导入的 workspace_* 四个别名
// toolName 在此注册,同样原生渲染。

export type WorkspaceToolKind = "read" | "write" | "edit" | "bash";

const KIND_BY_TOOL_NAME: Record<string, WorkspaceToolKind> = {
  // pi 原名(PC 原生)
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  // 安卓别名(备份导入,§9.1B)
  workspace_read_file: "read",
  workspace_write_file: "write",
  workspace_edit_file: "edit",
  workspace_shell: "bash",
};

export function workspaceToolKind(toolName: string): WorkspaceToolKind | null {
  return KIND_BY_TOOL_NAME[toolName] ?? null;
}

/** write/edit/bash 是"改变世界"的动作,抽出为顶层动作卡;read 留折叠组。 */
export function isWorkspaceActionTool(toolName: string): boolean {
  const kind = workspaceToolKind(toolName);
  return kind !== null && kind !== "read";
}

// ===== part 数据抽取(全部防御式:安卓导入的 args 键名可能有别) =====

function parseArgs(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** M1 契约:结构化 details 挂首个 text 输出条目的 metadata.workspace.details。 */
function workspaceDetails(tool: UIToolPart): Record<string, unknown> | null {
  for (const entry of tool.output) {
    if (!entry || typeof entry !== "object") continue;
    const meta = (entry as { metadata?: unknown }).metadata;
    if (!meta || typeof meta !== "object") continue;
    const workspace = (meta as Record<string, unknown>).workspace;
    if (!workspace || typeof workspace !== "object") continue;
    const details = (workspace as Record<string, unknown>).details;
    if (details && typeof details === "object") return details as Record<string, unknown>;
  }
  return null;
}

function outputText(tool: UIToolPart): string {
  return tool.output
    .filter((entry): entry is { type: "text"; text: string } =>
      Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text"),
    )
    .map((entry) => entry.text)
    .join("\n");
}

function outputError(tool: UIToolPart): string | null {
  for (const entry of tool.output) {
    if (entry && typeof entry === "object" && typeof (entry as { error?: unknown }).error === "string") {
      return (entry as { error: string }).error;
    }
  }
  return null;
}

/** read 徽标文案:offset/limit 存在时标注读取窗口。 */
export function readRangeBadge(args: Record<string, unknown>, t: TFunction): string | null {
  const offset = num(args, "offset");
  const limit = num(args, "limit");
  if (offset !== undefined && limit !== undefined) return t("workspace_tool.read_range_both", { offset, limit });
  if (offset !== undefined) return t("workspace_tool.read_range_offset", { offset });
  if (limit !== undefined) return t("workspace_tool.read_range_limit", { limit });
  return null;
}

/** 思维链折叠组里 read 步骤的标题(tool-part.tsx getToolTitle 调用)。 */
export function workspaceReadTitle(toolName: string, input: string, t: TFunction): string | null {
  if (workspaceToolKind(toolName) !== "read") return null;
  const args = parseArgs(input);
  const path = str(args, "path") ?? "";
  const range = readRangeBadge(args, t);
  const base = path ? t("workspace_tool.read_title", { path }) : t("workspace_tool.read");
  return range ? `${base} (${range})` : base;
}

/** 导出图/分享的工具卡可读标签(§9.8:至少 $ 命令与 diff 摘要)。 */
export function workspaceToolExportLabel(tool: UIToolPart, t: TFunction): string | null {
  const kind = workspaceToolKind(tool.toolName);
  if (!kind) return null;
  const args = parseArgs(tool.input);
  if (kind === "read") return workspaceReadTitle(tool.toolName, tool.input, t);
  if (kind === "bash") return `$ ${str(args, "command") ?? ""}`.trim();
  const path = str(args, "path") ?? "";
  if (kind === "write") return path ? t("workspace_tool.write_title_with_path", { path }) : t("workspace_tool.write_title");
  const details = workspaceDetails(tool);
  const diff = details && typeof details.diff === "string" ? details.diff : "";
  const stats = diff ? parseDiffStats(diff) : null;
  const base = path ? t("workspace_tool.edit_title_with_path", { path }) : t("workspace_tool.edit_title");
  return stats ? `${base} (+${stats.added} -${stats.removed})` : base;
}

// ===== 顶层动作卡 =====

interface CardModel {
  kind: WorkspaceToolKind;
  args: Record<string, unknown>;
  details: Record<string, unknown> | null;
  text: string;
  error: string | null;
  denied: boolean;
  deniedReason: string;
  /** 是否已有终局结果(bash 以结构化 exitCode 到位为准,其余以任何输出到位为准)。 */
  finished: boolean;
  exitCode: number | null;
}

function buildCardModel(tool: UIToolPart): CardModel {
  const kind = workspaceToolKind(tool.toolName) ?? "bash";
  const args = parseArgs(tool.input);
  const details = workspaceDetails(tool);
  const error = outputError(tool);
  const denied = tool.approvalState.type === "denied";
  const deniedReason = tool.approvalState.type === "denied" ? (tool.approvalState.reason ?? "") : "";
  const exitCode = details && typeof details.exitCode === "number" ? details.exitCode : null;
  const finished =
    denied || error !== null || (kind === "bash" ? details !== null && "exitCode" in details : tool.output.length > 0);
  return { kind, args, details, text: outputText(tool), error, denied, deniedReason, finished, exitCode };
}

const WRITE_PREVIEW_LINES = 12;

export function WorkspaceActionCard({ tool, loading }: { tool: UIToolPart; loading?: boolean }) {
  const { t } = useTranslation("message");
  const [expanded, setExpanded] = React.useState(true);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const model = React.useMemo(() => buildCardModel(tool), [tool]);
  const running = Boolean(loading) && !model.finished;
  const failed = model.error !== null || model.denied || (model.exitCode !== null && model.exitCode !== 0);

  const path = str(model.args, "path") ?? "";
  const command = str(model.args, "command") ?? "";
  const diff = model.details && typeof model.details.diff === "string" ? model.details.diff : "";
  const patch = model.details && typeof model.details.patch === "string" ? (model.details.patch as string) : "";
  const stats = React.useMemo(() => (diff ? parseDiffStats(diff) : null), [diff]);
  const writtenBytes = React.useMemo(() => {
    const match = model.text.match(/Successfully wrote (\d+) bytes/);
    return match ? Number(match[1]) : null;
  }, [model.text]);

  // H7:标题遵循全应用"工具名:操作对象"规则(同 联网搜索:词 / 加载技能:名)。
  const title =
    model.kind === "bash"
      ? command
      : path
        ? t(
            model.kind === "write"
              ? "workspace_tool.write_title_with_path"
              : "workspace_tool.edit_title_with_path",
            { path },
          )
        : model.kind === "write"
          ? t("workspace_tool.write_title")
          : t("workspace_tool.edit_title");
  const TitleIcon = model.kind === "bash" ? SquareTerminal : model.kind === "write" ? FilePlus2 : FilePen;

  const statusIcon = running ? (
    <Loader2 className="size-4 animate-spin text-primary" />
  ) : failed ? (
    <CircleX className="size-4 text-[oklch(0.55_0.18_25)] dark:text-[oklch(0.7_0.16_25)]" />
  ) : (
    <CircleCheck className="size-4 text-[oklch(0.55_0.14_150)] dark:text-[oklch(0.72_0.13_150)]" />
  );

  return (
    <>
      <div className="relative my-2 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
        {/* 运行中:左侧细进度条脉动(方案 §4.3);完成后收敛为头部图标状态 */}
        {running ? <span className="absolute inset-y-0 left-0 w-0.5 animate-pulse bg-primary" aria-hidden /> : null}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/40"
        >
          <span className="shrink-0">{statusIcon}</span>
          <TitleIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {model.kind === "bash" ? (
              <>
                {t("workspace_tool.bash_prefix")}
                <span className="font-mono text-[13px] font-normal">{title}</span>
              </>
            ) : (
              title
            )}
          </span>
          {stats ? (
            <span className="shrink-0 font-mono text-xs">
              <span className="text-[oklch(0.5_0.12_150)] dark:text-[oklch(0.75_0.12_150)]">+{stats.added}</span>{" "}
              <span className="text-[oklch(0.5_0.14_25)] dark:text-[oklch(0.75_0.14_25)]">-{stats.removed}</span>
            </span>
          ) : null}
          {writtenBytes !== null ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t("workspace_tool.bytes", { bytes: writtenBytes })}
            </span>
          ) : null}
          {model.exitCode !== null ? (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]",
                model.exitCode === 0
                  ? "bg-muted text-muted-foreground"
                  : "bg-[oklch(0.95_0.05_25)] text-[oklch(0.5_0.14_25)] dark:bg-[oklch(0.3_0.05_25)] dark:text-[oklch(0.75_0.14_25)]",
              )}
            >
              exit {model.exitCode}
            </span>
          ) : null}
          <span
            role="button"
            aria-label={t("workspace_tool.open_details")}
            onClick={(event) => {
              event.stopPropagation();
              setDrawerOpen(true);
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="size-3" />
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200",
              !expanded && "-rotate-90",
            )}
          />
        </button>

        {expanded ? (
          <div className="border-t border-border/50">
            {model.denied ? (
              <div className="px-3 py-2 text-xs text-destructive">
                {model.deniedReason
                  ? t("tool_part.denied_with_reason", { reason: model.deniedReason })
                  : t("tool_part.denied")}
              </div>
            ) : model.error !== null ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs text-destructive">
                {model.error}
              </pre>
            ) : model.kind === "edit" ? (
              <DiffView diff={diff} />
            ) : model.kind === "bash" ? (
              model.text || running ? (
                <TerminalOutput text={model.text} running={running} />
              ) : (
                <div className="px-3 py-2 text-xs text-muted-foreground">{t("workspace_tool.no_output")}</div>
              )
            ) : (
              <WriteBodyPreview content={str(model.args, "content") ?? ""} t={t} />
            )}
          </div>
        ) : null}
      </div>

      <DetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title={model.kind === "bash" ? `$ ${command}` : title}
        description={t("tool_part.tool_name_label", { toolName: tool.toolName })}
      >
        <div className="space-y-4">
          {model.kind !== "bash" && path ? (
            <div className="break-all font-mono text-xs text-muted-foreground">{path}</div>
          ) : null}
          {model.kind === "edit" && diff ? <DiffView diff={diff} className="rounded-md border" /> : null}
          {model.kind === "write" ? (
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-3 font-mono text-xs">
              {str(model.args, "content") ?? ""}
            </pre>
          ) : null}
          {model.text ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{t("tool_part.result")}</div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-3 font-mono text-xs">
                {model.text}
              </pre>
            </div>
          ) : null}
          {model.error !== null ? (
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs text-destructive">
              {model.error}
            </pre>
          ) : null}
          {patch ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{t("workspace_tool.patch")}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border bg-muted/20 p-3 font-mono text-xs">
                {patch}
              </pre>
            </div>
          ) : null}
        </div>
      </DetailDrawer>
    </>
  );
}

function WriteBodyPreview({ content, t }: { content: string; t: TFunction }) {
  const { preview, hidden } = React.useMemo(() => {
    const lines = content.split("\n");
    if (lines.length <= WRITE_PREVIEW_LINES) return { preview: content, hidden: 0 };
    return { preview: lines.slice(0, WRITE_PREVIEW_LINES).join("\n"), hidden: lines.length - WRITE_PREVIEW_LINES };
  }, [content]);
  if (!content) return <div className="px-3 py-2 text-xs text-muted-foreground">{t("workspace_tool.no_output")}</div>;
  return (
    <div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-5 text-foreground/90">
        {preview}
      </pre>
      {hidden > 0 ? (
        <div className="border-t border-border/40 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          {t("workspace_tool.write_preview_more", { count: hidden })}
        </div>
      ) : null}
    </div>
  );
}

// ===== 审批卡片(琥珀色左边条,完整展示将执行的命令/写入路径,方案 §4.3) =====

export function WorkspaceApprovalCard({
  tool,
  onToolApproval,
}: {
  tool: UIToolPart;
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
}) {
  const { t } = useTranslation("message");
  const kind = workspaceToolKind(tool.toolName) ?? "bash";
  const args = React.useMemo(() => parseArgs(tool.input), [tool.input]);
  const command = str(args, "command");
  const path = str(args, "path");
  // 审批缘由(后端 workspace/approval.ts 终局判定给出:危险命令说明/区外写入目标)。
  // "默认权限"档下用户只会在不安全操作时见到审批卡,必须告诉他为什么被拦。
  const pendingReason = tool.approvalState.type === "pending" ? (tool.approvalState.reason ?? "") : "";

  const handleApprove = async () => {
    if (!onToolApproval) return;
    await onToolApproval(tool.toolCallId, true, "");
  };
  const handleDeny = async () => {
    if (!onToolApproval) return;
    const reason = window.prompt(t("tool_part.deny_reason_prompt"), "");
    if (reason === null) return;
    await onToolApproval(tool.toolCallId, false, reason);
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-amber-500/30 border-l-4 border-l-amber-500 bg-amber-500/5 shadow-sm"
      role="region"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
          {kind === "bash" ? (
            <SquareTerminal className="size-4" />
          ) : kind === "read" ? (
            <FileText className="size-4" />
          ) : (
            <FilePen className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t(`workspace_tool.approval_${kind}`)}
            </span>
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
          </div>
          <p className="text-xs text-muted-foreground">{t("workspace_tool.approval_hint")}</p>
          {pendingReason ? (
            <p className="break-all text-xs font-medium text-amber-600 dark:text-amber-400">
              {t("workspace_tool.approval_reason", { reason: pendingReason })}
            </p>
          ) : null}
        </div>
      </div>

      {/* 完整展示将执行的命令/路径:审批决策必须基于完整信息,不截断关键载荷 */}
      <pre className="mx-4 mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/50 bg-background/70 px-3 py-2 font-mono text-xs">
        {kind === "bash" ? `$ ${command ?? ""}` : (path ?? "")}
      </pre>

      <div className="flex justify-end gap-2 px-4 py-3">
        <Button size="sm" variant="outline" onClick={handleDeny} disabled={!onToolApproval}>
          <X className="mr-1.5 size-3.5" />
          {t("tool_part.pending_deny")}
        </Button>
        <Button size="sm" onClick={handleApprove} disabled={!onToolApproval}>
          <Check className="mr-1.5 size-3.5" />
          {t("tool_part.pending_approve")}
        </Button>
      </div>
    </div>
  );
}
