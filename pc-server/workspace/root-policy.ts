import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isPathWithin, resolvePathIdentity, type PathIdentity } from "./path-identity";

/** 仅供 folder 工作区准入；full_access 的读写权限不使用此规则。 */
function systemDirectories(): string[] {
  if (process.platform === "win32") {
    return [
      process.env.SystemRoot || String.raw`C:\Windows`,
      process.env.ProgramFiles || String.raw`C:\Program Files`,
      process.env["ProgramFiles(x86)"] || String.raw`C:\Program Files (x86)`,
      process.env.ProgramData || String.raw`C:\ProgramData`,
    ].map((dir) => resolve(dir));
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/dev", "/proc", "/sys", "/var", "/System", "/Library"];
}

let darwinUserTempPath: string | undefined;

function darwinUserTempDirectory(): PathIdentity {
  // getconf 读取系统为当前用户分配的目录，不将可任意覆盖的 TMPDIR 当作白名单。
  darwinUserTempPath ??= execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
  }).trim();
  if (!darwinUserTempPath.startsWith("/")) throw new Error("无法确定 macOS 用户临时目录");
  return resolvePathIdentity(darwinUserTempPath);
}

export function isSystemWorkspaceRoot(root: PathIdentity): boolean {
  if (process.platform === "darwin" && isPathWithin(root, darwinUserTempDirectory())) return false;
  return systemDirectories().some((dir) => isPathWithin(root, resolvePathIdentity(dir)));
}
