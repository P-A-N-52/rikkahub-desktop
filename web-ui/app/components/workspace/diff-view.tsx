import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";

// Diff 视图(工作区 M2-3,方案 §4.3):渲染 edit 工具 details.diff 的展示型 diff。
// 该 diff 由服务端执行时算好(pi generateDiffString 格式:`+12 行内容`/`-12 行内容`/
// ` 12 上下文`/`    ...` 跳行标记),前端纯展示零计算(§4.5 有界渲染纪律)。
// 增/删行用极低饱和的绿/红底色(oklch 低 chroma,亮暗主题下都不刺眼),行号沟槽,
// 超过 collapseThreshold 行折叠中间(展开也只是显示预算好的行,无新计算)。

export interface DiffLine {
  sign: "+" | "-" | " ";
  lineNo: string;
  text: string;
  /** 跳行标记(` ... `),渲染为省略行。 */
  ellipsis?: boolean;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** 解析展示型 diff(格式见文件头注释)。逐行独立解析,不合格的行按上下文兜底,永不抛错。 */
export function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  return diff.split("\n").map((line) => {
    const sign = line[0] === "+" ? "+" : line[0] === "-" ? "-" : " ";
    const rest = line.slice(1);
    const match = rest.match(/^(\s*\d+) (.*)$/s);
    if (match) return { sign, lineNo: match[1]!.trim(), text: match[2]! };
    if (rest.trimEnd().endsWith("...") && sign === " ") return { sign, lineNo: "", text: "", ellipsis: true };
    return { sign: " ", lineNo: "", text: rest };
  });
}

/** +N/-M 统计(与安卓 parseDiffStats 同语义,驱动卡片头徽标)。 */
export function parseDiffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

const COLLAPSE_THRESHOLD = 20;
/** 折叠态首尾各保留的行数。 */
const COLLAPSE_EDGE = 8;

export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const { t } = useTranslation("message");
  const [expanded, setExpanded] = React.useState(false);
  const lines = React.useMemo(() => parseDiffLines(diff), [diff]);

  const collapsible = lines.length > COLLAPSE_THRESHOLD;
  const visible: Array<DiffLine | { fold: number }> = React.useMemo(() => {
    if (!collapsible || expanded) return lines;
    return [
      ...lines.slice(0, COLLAPSE_EDGE),
      { fold: lines.length - COLLAPSE_EDGE * 2 },
      ...lines.slice(lines.length - COLLAPSE_EDGE),
    ];
  }, [collapsible, expanded, lines]);

  if (lines.length === 0) {
    return <div className={cn("px-3 py-2 text-xs text-muted-foreground", className)}>{t("workspace_tool.diff_empty")}</div>;
  }

  return (
    <div className={cn("overflow-x-auto font-mono text-xs leading-5", className)}>
      {visible.map((line, index) => {
        if ("fold" in line) {
          return (
            <button
              key="fold"
              type="button"
              onClick={() => setExpanded(true)}
              className="block w-full bg-muted/40 px-3 py-1 text-center text-mini text-muted-foreground transition-colors duration-150 hover:bg-muted/70"
            >
              {t("workspace_tool.diff_show_more", { count: line.fold })}
            </button>
          );
        }
        return (
          <div
            key={index}
            className={cn(
              "flex whitespace-pre",
              line.sign === "+" && "bg-[oklch(0.95_0.05_150)] dark:bg-[oklch(0.3_0.05_150)]",
              line.sign === "-" && "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.3_0.05_25)]",
            )}
          >
            <span className="w-10 shrink-0 select-none border-r border-border/40 pr-1.5 text-right text-muted-foreground/70">
              {line.lineNo}
            </span>
            <span
              className={cn(
                "w-4 shrink-0 select-none text-center",
                line.sign === "+" && "text-[oklch(0.5_0.12_150)] dark:text-[oklch(0.75_0.12_150)]",
                line.sign === "-" && "text-[oklch(0.5_0.14_25)] dark:text-[oklch(0.75_0.14_25)]",
              )}
            >
              {line.ellipsis ? "" : line.sign.trim()}
            </span>
            <span className="pr-3">{line.ellipsis ? "⋯" : line.text}</span>
          </div>
        );
      })}
    </div>
  );
}
