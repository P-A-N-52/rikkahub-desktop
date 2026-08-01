import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";

// 终端输出块(工作区 M2-3,方案 §4.3/§4.5):bash 动作卡的流式输出区。
// 有界渲染纪律:流式期间只 slice 尾部 MAX_VISIBLE_LINES 行进普通 <pre>——
// 不进 Markdown/shiki 管线(终端输出无语法可言),每帧渲染成本与累计输出解耦。
// 限高+内滚动+跟随到底(用户上滚则暂停跟随,回底自动恢复);全量看详情抽屉。

const MAX_VISIBLE_LINES = 200;

export function TerminalOutput({
  text,
  running,
  className,
}: {
  text: string;
  running?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("message");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const followRef = React.useRef(true);

  const { visible, hiddenLines } = React.useMemo(() => {
    const lines = text.split("\n");
    if (lines.length <= MAX_VISIBLE_LINES) return { visible: text, hiddenLines: 0 };
    return {
      visible: lines.slice(lines.length - MAX_VISIBLE_LINES).join("\n"),
      hiddenLines: lines.length - MAX_VISIBLE_LINES,
    };
  }, [text]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  return (
    <div className={cn("min-w-0", className)}>
      {hiddenLines > 0 ? (
        <div className="border-b border-border/40 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          {t("workspace_tool.terminal_hidden_lines", { count: hiddenLines })}
        </div>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-64 overflow-auto px-3 py-2"
      >
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground/90">
          {visible}
          {running ? <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/70 align-middle" /> : null}
        </pre>
      </div>
    </div>
  );
}
