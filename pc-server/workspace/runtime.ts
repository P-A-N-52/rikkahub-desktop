// workspace/runtime.ts — 工作区工具运行时(M1-4:挂载判定 + 执行分发)
// 职责边界:本模块把"会话 → 工作区 → pi 工具实例"串成一条线——
//   挂载:openAiWorkspaceTools(conversation) 产出进模型的 tools 声明(条件挂载,§9.2);
//   执行:runWorkspaceTool(name, args, ctx) 构建有界工具实例并执行,产出 ToolResult 形状。
// 审批矩阵在 tools/approval.ts(纯函数在 ./approval.ts);路径边界在 ./boundary.ts;
// 工具内核是 ./tools/ 下的 pi 原样移植,本层不复制其任何逻辑。

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Conversation, JsonValue, TextPart, ToolOutputEntry, Workspace } from "../foundation/types";
import { getConversation } from "../conversations";
import { addLog } from "../api/logs";
import { getWorkspace, touchWorkspaceAccess, workspaceStatus, workspaceTmpDir } from "./index";
import { assertInsideWorkspace, createBoundedEditOperations, createBoundedReadOperations, createBoundedWriteOperations } from "./boundary";
import { skillsDir } from "../foundation/paths";
import { findDangerousCommandReason, isWorkspaceToolName, type WorkspaceToolName } from "./approval";
import { createReadTool } from "./tools/read";
import { createWriteTool } from "./tools/write";
import { createEditTool } from "./tools/edit";
import { createBashTool, type BashToolInput } from "./tools/bash";
import { getShellConfig } from "./tools/shell";
import type { WorkspaceToolDefinition, WorkspaceToolOutput } from "./tools/types";

// ----- shell 可用性探针(进程级缓存;Windows 无 Git Bash → bash 工具不挂载,§5.1) -----

let shellProbe: { available: boolean; error?: string } | null = null;

export function shellAvailability(): { available: boolean; error?: string } {
  if (!shellProbe) {
    try {
      getShellConfig();
      shellProbe = { available: true };
    } catch (err) {
      shellProbe = { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return shellProbe;
}

/** 用户装完 Git Bash 后从 UI 触发重探(M2 接线);单测亦用。 */
export function refreshShellAvailability(): void {
  shellProbe = null;
}

// ----- 会话 → 工作区运行时解析 -----

export interface WorkspaceRuntime {
  workspace: Workspace;
  /** 边界根(绝对路径) */
  root: string;
  /** 会话工作目录(恒在 root 边界内;丢失时自愈回 root) */
  cwd: string;
}

/** 会话可用工作区的三道闸:存在、根目录健在、已过信任门。返回不可用原因(人话,进错误文案)。 */
function workspaceUnavailableReason(workspace: Workspace | null): string | null {
  if (!workspace) return "the workspace bound to this conversation no longer exists";
  if (workspaceStatus(workspace) === "missing") {
    return `the workspace root folder is missing (${workspace.root})`;
  }
  if (workspace.type === "folder" && workspace.trustedAt == null) {
    return "the workspace folder has not been trusted yet — the user must confirm trust first";
  }
  return null;
}

function resolveCwd(workspace: Workspace, workspaceCwd: string | null | undefined): string {
  const raw = String(workspaceCwd ?? "").trim();
  if (!raw) return workspace.root;
  // 契约上 workspaceCwd 是边界内绝对路径;相对值按 root 解析(容错导入数据)。
  const absolute = isAbsolute(raw) ? raw : resolve(workspace.root, raw);
  try {
    const safe = assertInsideWorkspace(absolute, workspace.root);
    // cwd 目录被(agent 自己)删掉后自愈回 root,而不是让后续所有工具报错。
    return existsSync(safe) ? safe : workspace.root;
  } catch {
    return workspace.root;
  }
}

/** 挂载判定(静默):不可用返回 null,不抛——tools 声明装配在每轮请求热路径上。 */
export function workspaceRuntimeForConversation(
  conversation: Pick<Conversation, "workspaceId" | "workspaceCwd"> | null | undefined,
): WorkspaceRuntime | null {
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return null;
  const workspace = getWorkspace(workspaceId);
  if (workspaceUnavailableReason(workspace)) return null;
  return { workspace: workspace!, root: workspace!.root, cwd: resolveCwd(workspace!, conversation?.workspaceCwd) };
}

// ----- 工具实例构建(pi 内核 + 有界 Operations) -----

/** pi 默认工具顺序(system-prompt.ts:["read","bash","edit","write"]);声明与提示词共用。 */
export function mountedWorkspaceToolNames(): WorkspaceToolName[] {
  return shellAvailability().available ? ["read", "bash", "edit", "write"] : ["read", "edit", "write"];
}

function buildWorkspaceTool(name: WorkspaceToolName, runtime: WorkspaceRuntime): WorkspaceToolDefinition<unknown, unknown> {
  switch (name) {
    case "read":
      // M3-3:skillsDir 作只读根暴露给 read(对齐安卓 /skills 只读挂载);write/edit 仍单根。
      return createReadTool(runtime.cwd, { operations: createBoundedReadOperations(runtime.root, [skillsDir]) }) as WorkspaceToolDefinition<unknown, unknown>;
    case "write":
      return createWriteTool(runtime.cwd, { operations: createBoundedWriteOperations(runtime.root) }) as WorkspaceToolDefinition<unknown, unknown>;
    case "edit":
      return createEditTool(runtime.cwd, { operations: createBoundedEditOperations(runtime.root) }) as WorkspaceToolDefinition<unknown, unknown>;
    case "bash": {
      // tmp/ 放超长输出落盘;声明装配也走本函数(每轮热路径),existsSync 先挡一层
      const tmpDir = workspaceTmpDir(runtime.workspace.id);
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      return createBashTool(runtime.cwd, { tempFileDir: tmpDir }) as WorkspaceToolDefinition<unknown, unknown>;
    }
  }
}

/** 进模型的 tools 声明(OpenAI function 形状,与 tools/definitions.ts 生态一致)。
 *  条件挂载:非工作区会话/工作区不可用 → 空数组(同一会话内稳定,不破 tools 尾锚,§9.2)。 */
export function openAiWorkspaceTools(
  conversation: Pick<Conversation, "workspaceId" | "workspaceCwd"> | null | undefined,
): Array<Record<string, JsonValue>> {
  const runtime = workspaceRuntimeForConversation(conversation);
  if (!runtime) return [];
  return mountedWorkspaceToolNames().map((name) => {
    const tool = buildWorkspaceTool(name, runtime);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as JsonValue,
      },
    } as Record<string, JsonValue>;
  });
}

// ----- 执行分发 -----

/** bash 超时硬上限(秒,§5.1):pi 原样无默认 timeout,PC 加 30min 保护罩——
 *  模型没传 → 取硬上限;传了 → 夹到硬上限以内(无效值透传给 pi 内核报错)。 */
export const BASH_HARD_TIMEOUT_SECONDS = 30 * 60;

export function clampBashTimeoutSeconds(timeout: number | undefined): number {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return BASH_HARD_TIMEOUT_SECONDS;
  return Math.min(timeout, BASH_HARD_TIMEOUT_SECONDS);
}

/** details 里可能带整文件 diff;落库/广播前截断,保护消息体与前端渲染(§4.5 有界渲染)。 */
const DETAILS_TEXT_CAP = 100_000;

function jsonSafeDetails(details: unknown): Record<string, JsonValue> | null {
  if (details == null || typeof details !== "object") return null;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > DETAILS_TEXT_CAP) {
      out[key] = `${value.slice(0, DETAILS_TEXT_CAP)}\n[... truncated]`;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      // 不可序列化的字段直接丢弃(details 只服务渲染/导出,非正确性数据)
    }
  }
  return Object.keys(out).length ? out : null;
}

/** pi WorkspaceToolOutput → 调度器 ToolResult 形状(output 数组直通 toolResultToParts 首分支)。
 *  结构化 details 挂首个 text part 的 metadata.workspace(parts.ts 明示的扩展点),
 *  M2 渲染器与 M3 安卓导出适配层都吃这份数据。图片走 fileCreations 由协调器统一落盘。 */
function toToolResult(
  name: WorkspaceToolName,
  result: WorkspaceToolOutput<unknown>,
): { output: ToolOutputEntry[]; fileCreations?: Array<{ data: string; mime: string; prefix: string }> } {
  const output: ToolOutputEntry[] = [];
  const fileCreations: Array<{ data: string; mime: string; prefix: string }> = [];
  const details = jsonSafeDetails(result.details);
  let detailsAttached = false;
  for (const item of result.content) {
    if (item.type === "text") {
      const part: TextPart = { type: "text", text: item.text };
      if (details && !detailsAttached) {
        part.metadata = { workspace: { tool: name, details } };
        detailsAttached = true;
      }
      output.push(part);
    } else {
      fileCreations.push({ data: item.data, mime: item.mimeType, prefix: "workspace-read" });
    }
  }
  if (details && !detailsAttached) {
    output.push({ type: "text", text: "", metadata: { workspace: { tool: name, details } } });
  }
  return { output, ...(fileCreations.length ? { fileCreations } : {}) };
}

function requireStringArg(args: Record<string, JsonValue>, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool '${tool}' requires a non-empty string argument '${key}'.`);
  }
  return value;
}

function optionalNumberArg(args: Record<string, JsonValue>, key: string): number | undefined {
  const value = args[key];
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function logWorkspaceToolCall(
  runtime: WorkspaceRuntime,
  name: string,
  args: Record<string, JsonValue>,
  started: number,
  outcome: { ok: true; summary: string } | { ok: false; error: string },
): void {
  // 日志是旁路观测,绝不允许它反过来弄挂工具执行(单测无全局 state 时亦然)。
  try {
    addLog({
      providerId: "workspace",
      providerName: runtime.workspace.name,
      url: `workspace://${runtime.workspace.id}/${name}`,
      ok: outcome.ok,
      status: outcome.ok ? 200 : 500,
      kind: "tool:workspace",
      durationMs: Date.now() - started,
      method: "TOOL",
      requestBody: JSON.stringify(args).slice(0, 4_000),
      ...(outcome.ok ? { responseBody: outcome.summary.slice(0, 4_000) } : { error: outcome.error.slice(0, 4_000) }),
    });
  } catch {
    // 忽略:观测层失败不升级
  }
}

/** 工作区工具执行入口(executeToolCall 分发至此)。
 *  守卫链:会话归属 → 工作区三道闸 → (bash)shell 可用 + 危险命令拦截 → pi 内核执行。
 *  历史残留调用(会话已解绑/工作区已删)会命中守卫抛错——错误文案回灌模型,
 *  与 search_web 关闭后的守卫语义一致(execution.ts:87)。 */
export async function runWorkspaceTool(
  name: string,
  args: Record<string, JsonValue>,
  context?: {
    conversationId?: string;
    userApproved?: boolean;
    signal?: AbortSignal;
    onToolPartialOutput?: (output: ToolOutputEntry[]) => void;
  },
): Promise<{ output: ToolOutputEntry[]; fileCreations?: Array<{ data: string; mime: string; prefix: string }> }> {
  if (!isWorkspaceToolName(name)) throw new Error(`Unknown workspace tool: ${name}`);
  const conversation = context?.conversationId ? getConversation(context.conversationId) : null;
  if (!conversation?.workspaceId) {
    throw new Error(
      `Tool '${name}' is only available in workspace conversations. This conversation is not bound to a workspace — stop calling workspace tools.`,
    );
  }
  const workspace = getWorkspace(conversation.workspaceId);
  const unavailable = workspaceUnavailableReason(workspace);
  if (unavailable) throw new Error(`Workspace tools are unavailable: ${unavailable}.`);
  const runtime: WorkspaceRuntime = { workspace: workspace!, root: workspace!.root, cwd: resolveCwd(workspace!, conversation.workspaceCwd) };

  if (name === "bash") {
    const shell = shellAvailability();
    if (!shell.available) {
      throw new Error(`The bash tool is unavailable on this machine: ${shell.error ?? "no bash shell found"}`);
    }
    const command = requireStringArg(args, "command", name);
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason && !context?.userApproved) {
      // 危险命令拦截(§3.2:任何档位都拦,独立于审批)。执行层拦截而非审批态拦截,
      // 见 ./approval.ts 头注的一致性不变量。用户对 pending 卡显式批准 → userApproved
      // → 知情同意放行;full_access 免审路径永远进不到 userApproved,即"免审仍拦截"。
      throw new Error(
        `Command blocked by safety policy: it matches a destructive pattern (${dangerReason}) and was NOT executed. ` +
          `If the user genuinely wants this, ask them to run it manually or switch the workspace permission preset to per-step confirmation and approve it explicitly.`,
      );
    }
  }

  const started = Date.now();
  touchWorkspaceAccess(runtime.workspace.id);
  try {
    const tool = buildWorkspaceTool(name, runtime);
    let input: unknown;
    switch (name) {
      case "read":
        input = {
          path: requireStringArg(args, "path", name),
          offset: optionalNumberArg(args, "offset"),
          limit: optionalNumberArg(args, "limit"),
        };
        break;
      case "write":
        input = { path: requireStringArg(args, "path", name), content: String(args.content ?? "") };
        break;
      case "edit":
        // prepareEditArguments 在工具内核里做形状修复(legacy 顶层 oldText/JSON 字符串 edits)
        input = args;
        break;
      case "bash":
        input = { command: String(args.command), timeout: clampBashTimeoutSeconds(optionalNumberArg(args, "timeout")) } satisfies BashToolInput;
        break;
    }
    const onPartial = context?.onToolPartialOutput;
    const result = await tool.execute(
      input,
      context?.signal,
      // bash 执行中部分输出回写(pi onUpdate 全量快照语义,100ms 自节流);其余工具忽略该参数
      onPartial ? (partial) => onPartial(toToolResult(name, partial).output) : undefined,
    );
    const mapped = toToolResult(name, result);
    const summary = mapped.output
      .map((entry) => ("text" in entry && typeof entry.text === "string" ? entry.text : ""))
      .join("\n");
    logWorkspaceToolCall(runtime, name, args, started, { ok: true, summary });
    return mapped;
  } catch (err) {
    logWorkspaceToolCall(runtime, name, args, started, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
