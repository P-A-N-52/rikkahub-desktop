// tools/bound.ts — 绑定当前全局 state 的工具聚合器（把 definitions 的纯函数与运行时设置绑定）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。不进 tools/index.ts barrel（与 core 同名）。

import type { Assistant } from "../foundation/types";
import { state } from "../persistence/json-store";
import {
  openAiLocalTools as openAiLocalToolsCore,
  openAiMcpTools as openAiMcpToolsCore,
  openAiSearchTools as openAiSearchToolsCore,
  openAiSkillTools as openAiSkillToolsCore,
} from "./definitions";
import { listSkills } from "./skills";

export function openAiSearchTools() {
  return openAiSearchToolsCore(state.settings.enableWebSearch);
}

export function openAiSkillTools(assistant: Assistant) {
  return openAiSkillToolsCore(assistant, listSkills);
}

export function openAiLocalTools(assistant: Assistant) {
  return openAiLocalToolsCore(assistant, state.settings.memorySettings);
}

export function openAiMcpTools(assistant: Assistant) {
  return openAiMcpToolsCore(assistant, state.settings.mcpServers);
}

/** 会话级函数工具全集（M1-4）：四家装配点（orchestrator ×4 + conversation-encoding）
 *  的唯一聚合入口，消灭复读展开式。
 *  P6 退役:工作区工具条件挂载已移除——生成路由与旧挂载判定同用
 *  workspaceRuntimeForConversation,工作区可用必走 pi 会话(工具由
 *  pi-engine/workspace-tools 承载),不可用时旧挂载本就返回空,两头皆死代码。 */
export function conversationFunctionTools(assistant: Assistant) {
  return [
    ...openAiSearchTools(),
    ...openAiLocalTools(assistant),
    ...openAiSkillTools(assistant),
    ...openAiMcpTools(assistant),
  ];
}
