// backup/workspace-android-export.ts — 工作区动作历史的 PC→APP 导出适配层（方案 §9.1B 增强层）。
// PC 工具层全盘用 pi（read/write/edit/bash + pi 输出形状），安卓端注册的是
// workspace_read_file/workspace_write_file/workspace_edit_file/workspace_shell 且按
// 自有 JSON 契约渲染（WorkspaceToolUIs.kt）。本层在导出边界做单向映射，换来安卓原生
// diff view/终端卡渲染；不改写 PC 内部数据，APP→PC 方向不经此层（PC 渲染器直接认安卓名）。
//
// 安卓侧读取口径（已核实源码）：
// - arguments = Tool.input 的 JSON 解析；content = output 中 Text part 拼接后的 JSON 解析
// - read:  content.text；write: arguments.text；shell: content.{exitCode,stdout,stderr,timedOut}
// - edit:  output[0].metadata 平铺 {diff}（DiffMetadata）；未执行时 arguments.{old_text,new_text}
// 未能映射的形状（错误载荷等）原样保留，交由 wrapToolOutputEntriesForAndroid 兜底成
// 通用 text part——安卓 fallback 渲染器可看，绝不炸解码。

import { isRecord } from "../foundation/utils";

const PI_TO_ANDROID_TOOL_NAME: Record<string, string> = {
  read: "workspace_read_file",
  write: "workspace_write_file",
  edit: "workspace_edit_file",
  bash: "workspace_shell",
};

function parseInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** output 中 text 条目拼接（与安卓 ChatMessageTools 的 content 构造同口径）。 */
function joinedText(output: unknown[]): string {
  return output
    .filter((entry): entry is { type: "text"; text: string } =>
      isRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function firstErrorText(output: unknown[]): string | null {
  for (const entry of output) {
    if (isRecord(entry) && typeof entry.error === "string") return entry.error;
  }
  return null;
}

/** 取 runtime.ts 挂在首个 text 条目上的 metadata.workspace.details。 */
function workspaceDetails(output: unknown[]): Record<string, unknown> | null {
  for (const entry of output) {
    if (!isRecord(entry) || !isRecord(entry.metadata)) continue;
    const workspace = (entry.metadata as { workspace?: unknown }).workspace;
    if (isRecord(workspace) && isRecord(workspace.details)) return workspace.details as Record<string, unknown>;
  }
  return null;
}

function textEntry(json: Record<string, unknown>, metadata?: Record<string, unknown>): Record<string, unknown> {
  return { type: "text", text: JSON.stringify(json), ...(metadata ? { metadata } : {}) };
}

/** bash 非零退出/超时走 pi 报错文本（无结构化码），从状态行反解，尽量给安卓原生徽标供料。 */
function parseBashFailure(message: string): { exitCode?: number; timedOut: boolean } {
  const exitMatch = message.match(/Command exited with code (\d+)\s*$/);
  return {
    ...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
    timedOut: /Command timed out after \d+(?:\.\d+)? seconds\s*$/.test(message),
  };
}

/** 工作区工具 part → 安卓 workspace_* 形状。非工作区工具/已是安卓形状的 part 原样返回。
 *  纯函数,只作用于导出产物。output 为空(未执行/待审批)时仅改名——安卓按 arguments 预览。 */
export function adaptWorkspaceToolPartForAndroid(part: Record<string, unknown>): Record<string, unknown> {
  const piName = String(part.toolName ?? "");
  const androidName = PI_TO_ANDROID_TOOL_NAME[piName];
  if (!androidName || part.type !== "tool") return part;

  const args = parseInput(part.input);
  const output = Array.isArray(part.output) ? part.output : [];
  const adapted: Record<string, unknown> = { ...part, toolName: androidName };
  const error = firstErrorText(output);
  const executed = output.length > 0;

  if (piName === "read") {
    // 安卓 ReadFileToolUI: content.text。错误载荷不映射,留给 wrap 兜底(fallback 卡可见)。
    if (executed && error === null) {
      adapted.output = [textEntry({ path: String(args.path ?? ""), text: joinedText(output) })];
    }
    return adapted;
  }

  if (piName === "write") {
    // 安卓 WriteFileToolUI 只读 arguments.text;pi 的 content 键改名即完成映射。
    const { content, ...rest } = args;
    adapted.input = JSON.stringify({ ...rest, text: String(content ?? "") });
    if (executed && error === null) {
      adapted.output = [textEntry({ path: String(args.path ?? "") })];
    }
    return adapted;
  }

  if (piName === "edit") {
    // 未执行的预览 fallback 只认单组 old_text/new_text;多组 edits 不硬凑(留 DefaultToolPreview)。
    const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [];
    const single = edits.length === 1 ? edits[0] : null;
    adapted.input = JSON.stringify({
      path: String(args.path ?? ""),
      ...(single && typeof single.oldText === "string" && typeof single.newText === "string"
        ? { old_text: single.oldText, new_text: single.newText }
        : {}),
    });
    const diff = workspaceDetails(output)?.diff;
    if (executed && error === null) {
      adapted.output = [textEntry(
        { path: String(args.path ?? ""), replacements: edits.length },
        typeof diff === "string" && diff ? { diff } : undefined,
      )];
    }
    return adapted;
  }

  // bash → workspace_shell:安卓 ShellToolUI 读 content.{exitCode,stdout,stderr,timedOut}。
  if (executed) {
    if (error === null) {
      const details = workspaceDetails(output);
      const exitCode = typeof details?.exitCode === "number" ? details.exitCode : 0;
      adapted.output = [textEntry({ exitCode, stdout: joinedText(output), stderr: "", timedOut: false })];
    } else {
      // 失败输出整体在报错文本里(pi 语义),放 stderr;状态行可反解出码/超时。
      const failure = parseBashFailure(error);
      adapted.output = [textEntry({
        ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
        stdout: "",
        stderr: error,
        timedOut: failure.timedOut,
      })];
    }
  }
  return adapted;
}
