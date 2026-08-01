import * as React from "react";
import { Minus, Square, Copy, X } from "lucide-react";

import { cn } from "~/lib/utils";
import { ContainerTabBar } from "~/components/workspace/container-tab-bar";

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

  // M2-1 起标题栏常驻:它同时是一层容器标签栏的宿主,浏览器开发预览也需要同样的
  // 顶部让位(app.css 以 :has([data-tauri-drag-region]) 为门,本组件渲染即生效)。
  // 窗口控制按钮与拖拽仍只在 Tauri 下有意义(runWindowAction 在浏览器里静默为空)。

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
        // 沉浸式:不画背景、不留边框。窗口按钮和"Rikkahub"文字只是浮在透明拖拽区上,
        // 让 Mica 云母背景(或纯背景色)从窗口顶到底连续不断,没有灰条和接缝。
        // 内容区由 app.css 的 padding-top:2.25rem 往下让出 36px,所以这里下面是空的,
        // 无需毛玻璃(原来 bg-background/70 + backdrop-blur 就是制造"磨砂条"观感的元凶)。
        "fixed inset-x-0 top-0 z-50 flex h-9 select-none items-center justify-between",
        className,
      )}
    >
      {/* 中央区 = 一层容器标签栏(工作区 M2-1)。标签是 button,上面的 mousedown
          处理器会跳过 button 目标,拖拽窗口与点击标签互不干扰;标签间空白仍可拖拽。 */}
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3">
        <img
          src="/app-icon.png"
          alt=""
          data-tauri-drag-region
          className="size-4 shrink-0 rounded-sm opacity-90 pointer-events-none"
        />
        <ContainerTabBar />
      </div>

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
