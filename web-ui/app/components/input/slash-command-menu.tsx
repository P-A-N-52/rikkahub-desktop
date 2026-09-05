// input/slash-command-menu.tsx — 斜杠指令:推荐列表浮层 + 输入框指令染色镜像层
//
// 方案 tmp_doc/指令体系方案-2026-09-05.md §4.2/§4.3:
// - 列表锚定输入卡片上方(bottom-full),视觉与现有 Popover 同 token,不新造动效语言;
//   键盘导航由 use-slash-command 状态机负责,本组件纯展示 + 鼠标交互。
// - 染色用 backdrop 镜像层:textarea 无法富文本染色,命中完整指令时把 textarea
//   文字置透明(caret 保留),下层镜像 div 以完全相同的度量渲染文本,指令 token
//   染 --command(编辑器代码蓝,深浅主题共用,拍板 2026-09-05)。
//   度量 class 单源:TEXTAREA_METRICS 同时供 chat-input 的 Textarea 与镜像层使用,
//   杜绝两处漂移导致的字符错位(方案 §4.3 风险对策)。

import * as React from "react";

import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";
import type { SlashCommandDto } from "~/lib/slash-commands";

/** 输入框文本度量(影响字形排布的全部类,镜像层与 Textarea 共用单源)。
 *  组成:chat-input 对 ui/Textarea 的覆盖(p-2 text-sm)+ 基础组件中参与度量的
 *  w-full 与 md 字号档。行高继承 text-sm,两层同 class 组合必然同结果。 */
export const TEXTAREA_METRICS = "w-full p-2 text-sm md:text-[0.8125rem]";

export interface SlashCommandMenuProps {
  /** aria-controls 对齐用(textarea 侧标注)。 */
  id: string;
  commands: readonly SlashCommandDto[];
  selectedIndex: number;
  /** 当前过滤词(小写),用于条目内匹配段加粗。 */
  query: string;
  onHover: (index: number) => void;
  onPick: (command: SlashCommandDto) => void;
}

/** 指令名渲染:匹配段加粗(前缀优先,其次首个子串命中,与过滤规则同源直觉)。 */
function CommandName({ name, query }: { name: string; query: string }) {
  const start = query ? name.toLowerCase().indexOf(query) : -1;
  if (start < 0) return <span className="font-medium">/{name}</span>;
  const end = start + query.length;
  return (
    <span className="font-medium">
      /{name.slice(0, start)}
      <span className="font-semibold text-[var(--command)]">{name.slice(start, end)}</span>
      {name.slice(end)}
    </span>
  );
}

export function SlashCommandMenu({ id, commands, selectedIndex, query, onHover, onPick }: SlashCommandMenuProps) {
  const { t } = useTranslation("input");
  if (commands.length === 0) return null;
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t("commands.menu_label")}
      className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-[360px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
    >
      <div className="max-h-[240px] overflow-y-auto p-1">
        {commands.map((command, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={command.name}
              id={`${id}-option-${command.name}`}
              role="option"
              aria-selected={active}
              type="button"
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                active && "bg-accent text-accent-foreground",
              )}
              onMouseEnter={() => onHover(index)}
              // onMouseDown 抢在 textarea blur 之前完成补全,避免焦点抖动。
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(command);
              }}
            >
              <span className="flex items-baseline gap-2">
                <CommandName name={command.name} query={query} />
                {command.hasArgument ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {t(`commands.${command.name}.argument_hint`, { defaultValue: "" })}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`commands.${command.name}.description`, { defaultValue: "" })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface CommandHighlightOverlayProps {
  text: string;
  /** 指令 token 长度(含斜杠;parseSlashCommand 命中产物)。 */
  tokenLength: number;
}

/** 染色镜像层:绝对定位铺满输入区包装层(高度由 textarea 撑起,inset-0 自动重合),
 *  以与 textarea 完全相同的度量渲染文本,指令段染 --command 色。挂载条件(命中
 *  完整指令且非 IME 组合中)由 chat-input 控制;滚动同步经 ref 由 onScroll 驱动。 */
export const CommandHighlightOverlay = React.forwardRef<HTMLDivElement, CommandHighlightOverlayProps>(
  function CommandHighlightOverlay({ text, tokenLength }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden
        className={cn(
          TEXTAREA_METRICS,
          "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[var(--ds-text-primary)]",
        )}
      >
        <span className="text-[var(--command)]">{text.slice(0, tokenLength)}</span>
        {text.slice(tokenLength)}
      </div>
    );
  },
);
