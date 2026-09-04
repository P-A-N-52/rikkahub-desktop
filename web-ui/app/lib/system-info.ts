// 真实操作系统信息。桌面壳内走 Tauri 的 OS 插件(取到 Windows/Linux 真实版本),
// 浏览器 dev 模式回退到 navigator。集中一处,避免各组件各自判断 Tauri 环境。

export interface SystemInfo {
  /** 显示用一行摘要,如 "Windows 11 Home China 26200 · x86_64"。 */
  summary: string;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "ios":
      return "iOS";
    case "android":
      return "Android";
    default:
      return platform;
  }
}

// navigator.userAgentData / userAgent 仅作 dev 浏览器兜底,不追求精确。
function fallbackInfo(): SystemInfo {
  if (typeof navigator === "undefined") return { summary: "Web" };
  const ua = navigator.userAgent;
  let label = "Web";
  if (/Windows NT 10/.test(ua)) label = "Windows";
  else if (/Mac OS X/.test(ua)) label = "macOS";
  else if (/Linux/.test(ua)) label = "Linux";
  const arch = /WOW64|Win64|x64/.test(ua) ? "x86_64" : "";
  return { summary: arch ? `${label} · ${arch}` : label };
}

let cached: SystemInfo | null = null;

/** 是否 Windows 平台(shell 路径等 Windows-only 设置的渲染开关)。
 *  同步快照:summary 以 Windows 开头即视为 Windows;异步首判经 getSystemInfo 预热缓存。 */
export function isWindowsPlatform(): boolean {
  return (cached ?? fallbackInfo()).summary.startsWith("Windows");
}

export async function getSystemInfo(): Promise<SystemInfo> {
  if (cached) return cached;
  if (!isTauriEnvironment()) {
    cached = fallbackInfo();
    return cached;
  }
  try {
    const os = await import("@tauri-apps/plugin-os");
    const platform = await os.platform();
    const version = typeof os.version === "function" ? os.version() : "";
    const arch = typeof os.arch === "function" ? os.arch() : "";
    const label = platformLabel(platform);
    const parts = [label, version, arch].filter((part) => Boolean(part));
    cached = { summary: parts.join(" ") };
    return cached;
  } catch (err) {
    console.warn("[system-info] Tauri OS plugin failed, falling back", err);
    cached = fallbackInfo();
    return cached;
  }
}
