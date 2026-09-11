import { arch, platform, version, type Platform } from "@tauri-apps/plugin-os";
import { isDesktopShell } from "./external-link";

// OS 插件的这三个 API 同步读取壳启动时注入的信息,首帧即可确定原生窗控策略。
// 浏览器预览回退到 navigator;显示摘要不参与平台或能力判断。
export type SystemPlatform = Platform | "web";

export interface SystemInfo {
  platform: SystemPlatform;
  /** 显示用一行摘要,如 "Windows 11 Home China 26200 · x86_64"。 */
  summary: string;
}

export const isTauriEnvironment = isDesktopShell;

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
  if (typeof navigator === "undefined") return { platform: "web", summary: "Web" };
  const ua = navigator.userAgent;
  let platform: SystemPlatform = "web";
  if (/Windows NT/.test(ua)) platform = "windows";
  else if (/iPhone|iPad|iPod/.test(ua)) platform = "ios";
  else if (/Android/.test(ua)) platform = "android";
  else if (/Mac OS X/.test(ua)) platform = "macos";
  else if (/Linux/.test(ua)) platform = "linux";
  const label = platform === "web" ? "Web" : platformLabel(platform);
  const arch = /WOW64|Win64|x64/.test(ua) ? "x86_64" : "";
  return { platform, summary: arch ? `${label} · ${arch}` : label };
}

/** 同步平台快照,供首帧布局及窗口事件入口使用。 */
export function getSystemInfoSnapshot(): SystemInfo {
  if (!isTauriEnvironment()) return fallbackInfo();
  try {
    const currentPlatform = platform();
    const parts = [platformLabel(currentPlatform), version(), arch()].filter(Boolean);
    return { platform: currentPlatform, summary: parts.join(" ") };
  } catch (err) {
    console.warn("[system-info] Tauri OS plugin failed, falling back", err);
    return fallbackInfo();
  }
}

/** 是否 Windows 平台(shell 路径等 Windows-only 设置的渲染开关)。 */
export function isWindowsPlatform(): boolean {
  return getSystemInfoSnapshot().platform === "windows";
}

/** macOS 由原生标题栏处理窗控和拖拽;浏览器不接管页面鼠标事件。 */
export function usesCustomWindowControls(): boolean {
  return isTauriEnvironment() && getSystemInfoSnapshot().platform !== "macos";
}

// 保留关于页等现有异步调用接口。
export async function getSystemInfo(): Promise<SystemInfo> {
  return getSystemInfoSnapshot();
}
