import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import {
  getSystemInfo,
  getSystemInfoSnapshot,
  isTauriEnvironment,
  isWindowsPlatform,
  usesCustomWindowControls,
} from "~/lib/system-info";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setEnvironment(userAgent?: string, nativePlatform?: string) {
  if (userAgent === undefined) Reflect.deleteProperty(globalThis, "navigator");
  else Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
  });
  if (nativePlatform === undefined) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {},
      // 真实 OS plugin API 读取的宿主注入数据;不替换被测模块或插件函数。
      __TAURI_OS_PLUGIN_INTERNALS__: {
        platform: nativePlatform,
        version: "26.0",
        arch: "aarch64",
      },
    },
  });
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("desktop platform and window ownership", () => {
  test("预渲染环境不依赖 navigator 或 Tauri", async () => {
    setEnvironment();
    expect(await getSystemInfo()).toEqual({ platform: "web", summary: "Web" });
    expect(isTauriEnvironment()).toBe(false);
    expect(windowDragRegionProps()).toEqual({});
    expect(renderToStaticMarkup(<WindowControlsBar />)).toBe("");
  });

  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "linux"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "ios"],
    ["Mozilla/5.0 (Linux; Android 15)", "android"],
    ["Unknown browser", "web"],
  ])("浏览器平台识别 %s 不接管窗控", (userAgent, expectedPlatform) => {
    setEnvironment(userAgent);
    expect(getSystemInfoSnapshot().platform).toBe(expectedPlatform);
    expect(isWindowsPlatform()).toBe(expectedPlatform === "windows");
    expect(usesCustomWindowControls()).toBe(false);
    expect(windowDragRegionProps()).toEqual({});
    expect(renderToStaticMarkup(<WindowControlsBar />)).toBe("");
  });

  test("macOS 壳以真实 OS 为准,不渲染第二套窗控或接管页面双击", async () => {
    setEnvironment("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "macos");
    expect(await getSystemInfo()).toEqual({ platform: "macos", summary: "macOS 26.0 aarch64" });
    expect(isTauriEnvironment()).toBe(true);
    expect(isWindowsPlatform()).toBe(false);
    expect(usesCustomWindowControls()).toBe(false);
    expect(windowDragRegionProps()).toEqual({});
    expect(renderToStaticMarkup(<WindowControlsBar />)).toBe("");
  });

  test.each(["windows", "linux"])("%s 壳保留自绘条、页面拖拽和双击入口", (platform) => {
    setEnvironment("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform);
    expect(getSystemInfoSnapshot().platform).toBe(platform);
    expect(isWindowsPlatform()).toBe(platform === "windows");
    expect(usesCustomWindowControls()).toBe(true);
    const drag = windowDragRegionProps();
    expect(drag["data-tauri-drag-region"]).toBe(true);
    expect(typeof drag.onMouseDown).toBe("function");
    expect(typeof drag.onDoubleClick).toBe("function");
    expect(renderToStaticMarkup(<WindowControlsBar />)).toContain('data-tauri-drag-region="true"');
  });
});
