import * as React from "react";
import { useNavigate } from "react-router";
import { isTauriEnvironment } from "~/lib/system-info";

/** 将原生菜单的设置入口接到现有路由,始终保留当前 WebView 和前端状态。 */
export function DesktopMenuListener() {
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!isTauriEnvironment()) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      const unlisten = await listen("desktop://settings", () => {
        if (!cancelled) void navigate("/settings");
      });
      if (cancelled) unlisten();
      else dispose = unlisten;
    })().catch((error) => {
      console.warn("[desktop-menu] failed to register settings listener", error);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [navigate]);

  return null;
}
