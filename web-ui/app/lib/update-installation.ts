import { getSystemInfoSnapshot, isTauriEnvironment } from "./system-info";

/** A browser connected to a Mac server cannot open that server's cached local file. */
export function canOpenMacUpdate(serverPlatform?: string): boolean {
  return serverPlatform === "mac" && isTauriEnvironment() && getSystemInfoSnapshot().platform === "macos";
}

export async function openMacUpdateDmg(serverPlatform: string | undefined, path: string, version: string): Promise<void> {
  if (!canOpenMacUpdate(serverPlatform)) throw new Error("Open this update in the macOS desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  // This command validates the completed download and opens Finder. It never exits or
  // replaces the running app; the user follows the installation steps in the dialog.
  await invoke("open_update_dmg", { path, version });
}
