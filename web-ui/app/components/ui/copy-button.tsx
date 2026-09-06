// 通用复制按钮(域4-5 / 交互审查):封装 copyTextToClipboard + 已复制反馈态 + 失败 toast,
// 让 code-block、terminal-output、workspace-tool-part 三处共用同一套交互,不再复制粘贴。
// 纯图标、无文字(产品稿),悬停出 tooltip(title),复制成功短暂变对勾(success 语义色)。

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { copyTextToClipboard } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

export function CopyButton({
  text,
  label,
  copiedLabel,
  className,
  iconClassName,
}: {
  /** 要复制的全量原始内容(非截断后的展示窗口)。 */
  text: string;
  /** 无障碍/tooltip 文案(如"复制输出")。 */
  label: string;
  /** 已复制反馈的 tooltip 文案。 */
  copiedLabel: string;
  className?: string;
  iconClassName?: string;
}) {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);

  const handleCopy = React.useCallback(async () => {
    if (isCopied) return;
    try {
      await copyTextToClipboard(text);
      setIsCopied(true);
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast.error(label);
    }
  }, [text, isCopied, label]);

  React.useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  return (
    <Button
      aria-label={isCopied ? copiedLabel : label}
      title={isCopied ? copiedLabel : label}
      className={cn("size-6", className)}
      onClick={(event) => {
        event.stopPropagation();
        void handleCopy();
      }}
      size="icon-xs"
      type="button"
      variant="ghost"
    >
      {isCopied ? (
        <Check className={cn("size-3.5 text-success", iconClassName)} />
      ) : (
        <Copy className={cn("size-3.5", iconClassName)} />
      )}
    </Button>
  );
}
