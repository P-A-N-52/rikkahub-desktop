// workspace/approval.test.ts — 审批矩阵与危险命令拦截清单单测(M1-4,纯函数层)
import { describe, expect, test } from "bun:test";
import { findDangerousCommandReason, isWorkspaceToolName, workspaceToolNeedsApproval } from "./approval";

describe("审批矩阵(§3.2)", () => {
  test("read 任何档位免审", () => {
    expect(workspaceToolNeedsApproval("read", "confirm_each")).toBe(false);
    expect(workspaceToolNeedsApproval("read", "balanced")).toBe(false);
    expect(workspaceToolNeedsApproval("read", "full_access")).toBe(false);
  });

  test("write/edit 仅每步确认档审批", () => {
    for (const tool of ["write", "edit"] as const) {
      expect(workspaceToolNeedsApproval(tool, "confirm_each")).toBe(true);
      expect(workspaceToolNeedsApproval(tool, "balanced")).toBe(false);
      expect(workspaceToolNeedsApproval(tool, "full_access")).toBe(false);
    }
  });

  test("bash 仅完全访问档免审", () => {
    expect(workspaceToolNeedsApproval("bash", "confirm_each")).toBe(true);
    expect(workspaceToolNeedsApproval("bash", "balanced")).toBe(true);
    expect(workspaceToolNeedsApproval("bash", "full_access")).toBe(false);
  });

  test("工具名判别", () => {
    expect(isWorkspaceToolName("read")).toBe(true);
    expect(isWorkspaceToolName("bash")).toBe(true);
    expect(isWorkspaceToolName("search_web")).toBe(false);
    expect(isWorkspaceToolName("mcp__read")).toBe(false);
    expect(isWorkspaceToolName("")).toBe(false);
  });
});

describe("危险命令拦截清单(任何档位都拦,§3.2)", () => {
  const dangerous = [
    "rm -rf /",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf $HOME",
    "sudo rm -rf /",
    "rm -rf / --no-preserve-root",
    "rm -rf /etc",
    "rm -rf /usr && echo done",
    "rm -rf C:\\",
    "rm -rf c:/",
    'rm -rf "C:\\"',
    "del /s /q C:\\",
    "rd /s /q C:",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sdb",
    "format C:",
    "echo hi && diskpart",
    "dd if=/dev/zero of=/dev/sda",
    "cat /dev/urandom > /dev/sda",
    "chmod -R 777 /",
    'reg delete "HKLM\\SOFTWARE" /f',
    ":(){ :|:& };:",
  ];
  for (const cmd of dangerous) {
    test(`拦截: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).not.toBeNull();
    });
  }

  const safe = [
    "ls -la",
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/mydir",
    "rm foo.txt",
    "rm -rf src/generated && bun run codegen",
    "git rm -r --cached .",
    "del build\\out.txt",
    "echo 'rm -rf /' > docs/danger-examples.md", // 字面量写入文档不执行……但保守拦截也可接受?不:重定向目标非设备,正则不命中
    "dd if=./disk.img of=./backup.img",
    "chmod 755 scripts/build.sh",
    "chmod -R 644 ./dist",
    "reg query HKCU\\Software",
    "format-code --all",
    "grep -r 'mkfs' docs/",
  ];
  for (const cmd of safe) {
    test(`放行: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).toBeNull();
    });
  }
});
