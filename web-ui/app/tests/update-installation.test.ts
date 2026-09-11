import { afterEach, describe, expect, test } from "bun:test";
import { canOpenMacUpdate, openMacUpdateDmg } from "~/lib/update-installation";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const calls: Array<{ command: string; args: unknown }> = [];

function environment(platform?: string, fail = false) {
  calls.length = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
  if (!platform) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          if (fail) throw new Error("Update package checksum does not match");
        },
      },
      __TAURI_OS_PLUGIN_INTERNALS__: { platform, version: "26.0", arch: "aarch64" },
    },
  });
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("manual macOS update installation", () => {
  test("browser or another platform never invokes a local DMG command", async () => {
    for (const platform of [undefined, "windows", "linux"]) {
      environment(platform);
      expect(canOpenMacUpdate("mac")).toBe(false);
      await expect(openMacUpdateDmg("mac", "/remote/cache/update.dmg", "2.1.0")).rejects.toThrow("desktop app");
      expect(calls).toEqual([]);
    }
    environment("macos");
    expect(canOpenMacUpdate("win")).toBe(false);
    expect(canOpenMacUpdate(undefined)).toBe(false);
  });

  test("Mac desktop passes exact path/version to verification and never requests exit", async () => {
    environment("macos");
    const path = "/Users/qa/Library/Application Support/com.rikkahub.pc/pc-data/updates/Rikkahub_2.1.0+build.01_mac_arm64.dmg";
    expect(canOpenMacUpdate("mac")).toBe(true);
    await openMacUpdateDmg("mac", path, "2.1.0+build.01");
    expect(calls).toEqual([{ command: "open_update_dmg", args: { path, version: "2.1.0+build.01" } }]);
  });

  test("native verification errors propagate without exit or another command", async () => {
    environment("macos", true);
    await expect(openMacUpdateDmg("mac", "/cached/update.dmg", "2.1.0")).rejects.toThrow("checksum");
    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe("open_update_dmg");
  });
});
