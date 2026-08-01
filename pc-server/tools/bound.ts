// tools/bound.ts — 绑定当前全局 state 的工具聚合器（把 definitions 的纯函数与运行时设置绑定）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。不进 tools/index.ts barrel（与 core 同名）。

import type { Assistant, Conversation } from "../foundation/types";
import { state } from "../persistence/json-store";
import { openAiWorkspaceTools } from "../workspace/runtime";
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
 *  的唯一聚合入口，消灭复读展开式。工作区工具条件挂载（workspaceId 非空且工作区
 *  可用），追加在末尾——同一会话内集合稳定，不破 Claude tools 尾块缓存锚（§9.2）。 */
export function conversationFunctionTools(assistant: Assistant, conversation?: Conversation | null) {
  return [
    ...openAiSearchTools(),
    ...openAiLocalTools(assistant),
    ...openAiSkillTools(assistant),
    ...openAiMcpTools(assistant),
    ...openAiWorkspaceTools(conversation),
  ];
}
