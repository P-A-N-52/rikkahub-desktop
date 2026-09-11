import * as React from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";
import { usesCustomWindowControls } from "~/lib/system-info";

// I1(无边框窗口回归,按 NewMax 框架结构):顶部与侧边栏同色的窗控条,文档流内布局
// (不是 fixed 覆盖层——G 轮教训:fixed 拖拽层 + isolate 层叠上下文会盖住标签行)。
// macOS 使用原生标题栏;浏览器开发预览下整条不渲染。

type WindowApi = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  startDragging: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

async function loadWindowApi(): Promise<WindowApi | null> {
  if (!usesCustomWindowControls()) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    return {
      minimize: () => win.minimize(),
      toggleMaximize: () => win.toggleMaximize(),
      close: () => win.close(),
      startDragging: () => win.startDragging(),
      isMaximized: () => win.isMaximized(),
      onResized: (handler) => win.onResized(handler).then((unlisten) => () => unlisten()),
    };
  } catch (err) {
    console.warn("[window-controls] failed to load Tauri window API", err);
    return null;
  }
}

// API 模块级缓存:窗控条与各拖拽区共享一次动态 import。
let cachedApi: Promise<WindowApi | null> | null = null;
function windowApi(): Promise<WindowApi | null> {
  cachedApi ??= loadWindowApi();
  return cachedApi;
}

function runWindowAction(fn: (api: WindowApi) => Promise<void>) {
  void windowApi().then((api) => {
    if (!api) return;
    fn(api).catch((err) => console.warn("[window-controls] window action failed", err));
  });
}

// WebView2 对 data-tauri-drag-region 的声明式识别偶发失效(光标下无绘制内容时),
// mousedown 里直接 startDragging() 跨版本可靠。
// 关键闸门:点击拖拽区内交互元素时事件会冒泡到这里,若不跳过会立即进入原生拖拽、OS 捕获
// 鼠标,click 永远不触发("点不动"假死)。放行必须覆盖全部交互形态:shadcn 的
// <Button asChild><Link>> 渲染成 <a>(设置页/图像页返回键正是它——曾因只放行 button
// 而假死,问题7回访),外加 input/label/role=button 等潜在形态,一次收口。
const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, label, [role='button']";
function handleDragMouseDown(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  runWindowAction((api) => api.startDragging());
}
function handleDragDoubleClick(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  event.preventDefault();
  runWindowAction((api) => api.toggleMaximize());
}

/** 自绘窗控模式下提供拖拽和双击最大化;原生标题栏模式保留页面原有鼠标行为。 */
export function windowDragRegionProps() {
  if (!usesCustomWindowControls()) return {};
  return {
    "data-tauri-drag-region": true,
    onMouseDown: handleDragMouseDown,
    onDoubleClick: handleDragDoubleClick,
  } as const;
}

export function WindowControlsBar({ className }: { className?: string }) {
  const { t } = useTranslation("page");
  const [maximized, setMaximized] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const customControls = usesCustomWindowControls();

  React.useEffect(() => {
    if (!customControls) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const api = await windowApi();
      if (!api || cancelled) return;
      setReady(true);
      const refreshMaximized = async () => {
        try {
          const maximized = await api.isMaximized();
          if (!cancelled) setMaximized(maximized);
        } catch {
          // 取不到时保留上次窗口状态。
        }
      };
      await refreshMaximized();
      if (cancelled) return;
      try {
        const unlisten = await api.onResized(() => void refreshMaximized());
        if (cancelled) unlisten();
        else dispose = unlisten;
      } catch {
        // 监听注册尽力而为。
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [customControls]);

  if (!customControls) return null;

  return (
    <div
      {...windowDragRegionProps()}
      className={cn(
        "flex h-[22px] shrink-0 select-none items-center justify-end",
        className,
      )}
    >
      {ready ? (
        <div className="flex h-full items-center">
          <WindowControlButton
            variant="default"
            ariaLabel={t("window_controls.minimize")}
            onClick={() => runWindowAction((api) => api.minimize())}
          >
            <Minus className="size-3.5" strokeWidth={1.5} />
          </WindowControlButton>
          <WindowControlButton
            variant="default"
            ariaLabel={maximized ? t("window_controls.restore") : t("window_controls.maximize")}
            onClick={() => runWindowAction((api) => api.toggleMaximize())}
          >
            {maximized ? (
              <Copy className="size-3 -scale-x-100" strokeWidth={1.5} />
            ) : (
              <Square className="size-3" strokeWidth={1.5} />
            )}
          </WindowControlButton>
          <WindowControlButton
            variant="danger"
            ariaLabel={t("window_controls.close")}
            onClick={() => runWindowAction((api) => api.close())}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </WindowControlButton>
        </div>
      ) : null}
    </div>
  );
}

function WindowControlButton({
  children,
  onClick,
  ariaLabel,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  variant: "default" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "flex h-5 w-10 items-center justify-center rounded-md text-muted-foreground transition-all duration-150 active:scale-95",
        variant === "default" && "hover:bg-[var(--ds-on-surface)] hover:text-foreground active:bg-[var(--ds-on-surface-active)]",
        variant === "danger" &&
          "hover:bg-destructive hover:text-destructive-foreground active:bg-destructive/80",
      )}
    >
      {children}
    </button>
  );
}
