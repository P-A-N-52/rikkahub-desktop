// Update versions, release discovery and completed installer cache.
import { readFileSync, writeFileSync } from "node:fs";
import { skipVersionPath } from "../foundation/paths";

export * from "./releases";
export * from "./download";

export function readSkippedVersion(): string {
  try { return readFileSync(skipVersionPath, "utf-8").trim(); } catch { return ""; }
}
export function writeSkippedVersion(version: string) {
  try { writeFileSync(skipVersionPath, version.trim()); } catch { /* best-effort */ }
}

// 版本号唯一修改入口：`bun run version:bump <x.y.z>`；check-version-sync 同时检查壳配置。
export const APP_VERSION = "2.0.0";
