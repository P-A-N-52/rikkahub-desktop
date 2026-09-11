import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePathIdentity } from "./path-identity";
import { isSystemWorkspaceRoot } from "./root-policy";

const host = mkdtempSync(join(process.env.RIKKAHUB_PATH_TEST_DIR ?? tmpdir(), "rkh-root-policy-"));
const createdDirectories = [host];
const ordinary = join(host, "project");
mkdirSync(ordinary);

afterAll(() => {
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("folder 系统目录策略", () => {
  test("系统目录及后代被拒", () => {
    expect(isSystemWorkspaceRoot(resolvePathIdentity("/etc"))).toBe(true);
    expect(isSystemWorkspaceRoot(resolvePathIdentity("/usr/lib"))).toBe(true);
    expect(isSystemWorkspaceRoot(resolvePathIdentity("/var"))).toBe(true);
  });

  test("普通夹具目录可作为工作区", () => {
    expect(isSystemWorkspaceRoot(resolvePathIdentity(ordinary))).toBe(false);
  });

  test("普通位置的系统目录别名仍被拒", () => {
    const alias = join(host, "system-alias");
    symlinkSync("/etc", alias);
    expect(isSystemWorkspaceRoot(resolvePathIdentity(alias))).toBe(true);
  });
});

describe.skipIf(process.platform !== "darwin")("macOS 用户临时目录例外", () => {
  test("getconf 确认的用户临时根及其后代可用", () => {
    const systemTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
    const child = mkdtempSync(join(systemTemp, "rkh-root-policy-user-temp-"));
    createdDirectories.push(child);
    expect(isSystemWorkspaceRoot(resolvePathIdentity(systemTemp))).toBe(false);
    expect(isSystemWorkspaceRoot(resolvePathIdentity(child))).toBe(false);
    expect(isSystemWorkspaceRoot(resolvePathIdentity("/private/var"))).toBe(true);
    expect(isSystemWorkspaceRoot(resolvePathIdentity("/private/var/folders"))).toBe(true);

    const escape = join(child, "system-link");
    symlinkSync("/etc", escape);
    expect(isSystemWorkspaceRoot(resolvePathIdentity(escape))).toBe(true);
  });

  test("全新进程的 TMPDIR=/var 不会扩大系统临时目录例外", () => {
    const pathModule = JSON.stringify(join(import.meta.dir, "path-identity.ts"));
    const policyModule = JSON.stringify(join(import.meta.dir, "root-policy.ts"));
    const script = `
      import { resolvePathIdentity } from ${pathModule};
      import { isSystemWorkspaceRoot } from ${policyModule};
      for (const path of ["/var", "/private/var", "/var/folders", "/etc"]) {
        if (!isSystemWorkspaceRoot(resolvePathIdentity(path))) throw new Error("System root was allowed: " + path);
      }
    `;
    expect(() => execFileSync(process.execPath, ["--eval", script], {
      env: { TMPDIR: "/var" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })).not.toThrow();
  });
});
