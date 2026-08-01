// workspace/prompt.ts — 工作区系统提示词段(M1-4,pi buildSystemPrompt 结构照搬)
// 来源:pi/packages/coding-agent/src/core/system-prompt.ts(MIT)。骨架与工具
// snippet/guideline 文案逐字保留;剔除 pi 自述文档段(README/docs/examples 指路,
// 纯 pi CLI 私货);<project_context> 装 AGENTS.md(pi 的 contextFiles 机制)。
//
// 缓存纪律(§9.2):本段只含会话内稳定信息——工具清单(进程级 shell 探针,会话内不变)、
// root/cwd(会话字段,变更=有意破缓存)、AGENTS.md(会话级冻结快照,中途改文件不重读,
// 与 context-snapshots.ts 的记忆冻结同一套论证:改动在工具结果里模型本就看得见)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation } from "../foundation/types";
import { mountedWorkspaceToolNames, workspaceRuntimeForConversation } from "./runtime";
import type { WorkspaceToolName } from "./approval";

// pi 各工具的 promptSnippet 原文(read.ts:213 / bash.ts:328 / edit.ts:297 / write.ts:191)
const TOOL_SNIPPETS: Record<WorkspaceToolName, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
};

// pi 各工具的 promptGuidelines 原文(bash 无;顺序按工具挂载序,后接恒有的两条)
const TOOL_GUIDELINES: Record<WorkspaceToolName, string[]> = {
  read: ["Use read to examine files instead of cat or sed."],
  bash: [],
  edit: [
    "Use edit for precise changes (edits[].oldText must match exactly)",
    "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
    "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  ],
  write: ["Use write only for new files or complete rewrites."],
};

const AGENTS_FILE = "AGENTS.md";
const MAX_SNAPSHOTS = 200;

/** AGENTS.md 会话级冻结快照(LRU,套路同 context-snapshots.ts)。null=无文件/读失败。 */
const agentsSnapshots = new Map<string, string | null>();

function frozenAgentsContent(conversationId: string, root: string): string | null {
  const key = `${conversationId}|${root}`;
  if (agentsSnapshots.has(key)) {
    const hit = agentsSnapshots.get(key) ?? null;
    agentsSnapshots.delete(key);
    agentsSnapshots.set(key, hit);
    return hit;
  }
  let content: string | null = null;
  try {
    content = readFileSync(join(root, AGENTS_FILE), "utf8").trim() || null;
  } catch {
    content = null; // 无 AGENTS.md 是常态,非错误
  }
  agentsSnapshots.set(key, content);
  if (agentsSnapshots.size > MAX_SNAPSHOTS) {
    const oldest = agentsSnapshots.keys().next().value;
    if (oldest !== undefined) agentsSnapshots.delete(oldest);
  }
  return content;
}

/** 单测/未来"重读项目指引"动作用。 */
export function invalidateWorkspacePromptSnapshots(): void {
  agentsSnapshots.clear();
}

/** 工作区会话的系统提示词段;非工作区会话/工作区不可用返回 ""。
 *  结构照搬 pi buildSystemPrompt(身份句 → Available tools → Guidelines →
 *  <project_context> → Current working directory)。 */
export function buildWorkspacePromptSegment(conversation: Conversation): string {
  const runtime = workspaceRuntimeForConversation(conversation);
  if (!runtime) return "";

  const tools = mountedWorkspaceToolNames();
  const toolsList = tools.map((name) => `- ${name}: ${TOOL_SNIPPETS[name]}`).join("\n");

  // pi 的 guideline 组装序:bash 文件操作提示(有 bash 无 grep/find/ls 时)→ 各工具
  // guidelines(挂载序)→ 恒有两条;Set 去重语义此处天然满足(清单静态无重复)。
  const guidelines: string[] = [];
  if (tools.includes("bash")) guidelines.push("Use bash for file operations like ls, rg, find");
  for (const name of tools) guidelines.push(...TOOL_GUIDELINES[name]);
  guidelines.push("Be concise in your responses", "Show file paths clearly when working with files");
  const guidelinesList = guidelines.map((g) => `- ${g}`).join("\n");

  let prompt = `You are an expert coding assistant operating in workspace mode. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the conversation.

Guidelines:
${guidelinesList}`;

  const agents = frozenAgentsContent(conversation.id, runtime.root);
  if (agents) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    prompt += `<project_instructions path="${AGENTS_FILE}">\n${agents}\n</project_instructions>\n\n`;
    prompt += "</project_context>\n";
  }

  prompt += `\nCurrent working directory: ${runtime.cwd.replace(/\\/g, "/")}`;
  return prompt;
}
