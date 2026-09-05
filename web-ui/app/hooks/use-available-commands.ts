// hooks/use-available-commands.ts — 斜杠指令:可用清单获取
//
// 可用性由服务端权威判定(GET /api/commands,引擎路由材料在服务端;方案 §3.3),
// 前端只消费。切会话自动重取;取失败按空清单处理(指令面整体关闭,不打扰输入)。

import * as React from "react";

import type { SlashCommandDto } from "~/lib/slash-commands";
import api from "~/services/api";

const EMPTY: SlashCommandDto[] = [];

export function useAvailableCommands(conversationId: string | null): SlashCommandDto[] {
  const [commands, setCommands] = React.useState<SlashCommandDto[]>(EMPTY);

  React.useEffect(() => {
    if (!conversationId) {
      setCommands(EMPTY);
      return;
    }
    let cancelled = false;
    api
      .get<{ commands?: SlashCommandDto[] }>(`commands?conversationId=${encodeURIComponent(conversationId)}`)
      .then((result) => {
        if (!cancelled) setCommands(result.commands ?? EMPTY);
      })
      .catch(() => {
        if (!cancelled) setCommands(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return commands;
}
