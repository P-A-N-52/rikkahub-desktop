import * as React from "react";
import { Minus, Square, Copy, X } from "lucide-react";

import { cn } from "~/lib/utils";

// Detect Tauri at runtime so the same component is harmless when the dev preview
// runs in a normal browser (it returns null in that case).
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type WindowApi = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  startDragging: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

async function getWindowApi(): Promise<WindowApi | null> {
  if (!isTauri()) return null;
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
    console.warn("[titlebar] failed to load Tauri window API", err);
    return null;
  }
}

export function TitleBar({ className }: { className?: string }) {
  const [maximized, setMaximized] = React.useState(false);
  const [tauri, setTauri] = React.useState(false);
  const apiRef = React.useRef<WindowApi | null>(null);

  React.useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const api = await getWindowApi();
      if (cancelled) return;
      apiRef.current = api;
      setTauri(api != null);
      if (!api) return;
      try {
        setMaximized(await api.isMaximized());
      } catch {
        // No-op — initial state inferred from default (false).
      }
      try {
        dispose = await api.onResized(async () => {
          try {
            setMaximized(await api.isMaximized());
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore — listener registration is best-effort
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // 标题栏常驻(浏览器开发预览也渲染):app.css 以 :has([data-tauri-drag-region])
  // 为门的侧栏顶部让位依赖本组件存在。窗口控制按钮与拖拽只在 Tauri 下有意义
  // (runWindowAction 在浏览器里静默为空)。

  const runWindowAction = (fn: (api: WindowApi) => Promise<void>) => {
    const api = apiRef.current;
    if (!api) return;
    void fn(api).catch((err) => console.warn("[titlebar] window action failed", err));
  };

  // WebView2 occasionally fails to honor `data-tauri-drag-region` declaratively when the
  // drag target has no painted content under the cursor. Calling `startDragging()` directly
  // from a mousedown handler bypasses that and works reliably across Windows versions.
  //
  // CRITICAL: gate on the event target. Without this, a left-click on any titlebar button
  // bubbles up here, we immediately enter native drag, and the OS captures the mouse —
  // so `mouseup` never lands on the button and `onClick` never fires. The buttons appear
  // dead even though their click handlers are wired up correctly. Skipping when the
  // target is a button (or inside one) lets the normal click flow through.
  const handleDragMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button")) return;
    runWindowAction((api) => api.startDragging());
  };
  const handleDragDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button")) return;
    event.preventDefault();
    runWindowAction((api) => api.toggleMaximize());
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
      className={cn(
        // 沉浸式:透明全宽拖拽层 + 右上窗控,不画背景不留边框(前端重构A1)。
        // 一级容器标签已迁往正文列顶行(conversations.tsx):标签行 wrapper 关闭
        // pointer-events,空白处的鼠标事件穿透到本层完成窗口拖拽;标签本体以
        // z-50 浮在本层(z-40)之上恢复交互。settings 等无顶行内容的页面,
        // 整条 36px 都是拖拽区。
        "fixed inset-x-0 top-0 z-40 flex h-9 select-none items-center justify-end",
        className,
      )}
    >
      {tauri ? (
        <div className="flex h-full items-stretch">
          <TitleBarButton
            variant="default"
            ariaLabel="最小化"
            onClick={() => runWindowAction((api) => api.minimize())}
          >
            <Minus className="size-3.5" strokeWidth={1.5} />
          </TitleBarButton>
          <TitleBarButton
            variant="default"
            ariaLabel={maximized ? "还原" : "最大化"}
            onClick={() => runWindowAction((api) => api.toggleMaximize())}
          >
            {maximized ? (
              <Copy className="size-3 -scale-x-100" strokeWidth={1.5} />
            ) : (
              <Square className="size-3" strokeWidth={1.5} />
            )}
          </TitleBarButton>
          <TitleBarButton
            variant="danger"
            ariaLabel="关闭"
            onClick={() => runWindowAction((api) => api.close())}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </TitleBarButton>
        </div>
      ) : null}
    </div>
  );
}

function TitleBarButton({
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
        "flex h-full w-11 items-center justify-center rounded-none text-muted-foreground transition-all duration-150 active:scale-95",
        variant === "default" &&
          "hover:rounded-md hover:bg-muted hover:text-foreground active:bg-muted/70",
        variant === "danger" &&
          "hover:rounded-md hover:bg-destructive hover:text-destructive-foreground active:bg-destructive/80",
      )}
    >
      {children}
    </button>
  );
}
