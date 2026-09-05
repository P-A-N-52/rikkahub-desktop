// api/handlers/commands.ts — 斜杠指令可用性清单
//
// GET /api/commands?conversationId=xxx
// 服务端是可用性的唯一权威(引擎路由判定材料在服务端;方案 §3.3):前端只消费
// 清单做补全/染色/拦截,不得自行判定。会话不存在(新会话未落库/已删除)返回空
// 清单——没有会话就没有指令作用对象,指令面整体关闭,与"禁用即不存在"同语义。

import { getConversation } from "../../conversations";
import { resolveEngineForConversation } from "../../conversations/orchestrator";
import { resolveAvailableCommands } from "../../commands/registry";
import { json } from "../request";

export async function handleCommandRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "commands" && request.method === "GET") {
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = conversationId ? getConversation(conversationId) : null;
    if (!conversation) return json({ commands: [] });
    const engineKind = resolveEngineForConversation(conversation).kind;
    return json({ commands: resolveAvailableCommands(engineKind) });
  }
  return null;
}
