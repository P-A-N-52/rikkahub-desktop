// lib/slash-commands.ts — 斜杠指令:前端解析纯函数(触发/过滤/完整判定)
//
// 方案 tmp_doc/指令体系方案-2026-09-05.md §4.1:
// - 仅文本开头的 "/" 触发;未注册或当前环境禁用的 /xxx 原样发送(不惊扰原则);
//   可用清单来自 GET /api/commands(服务端权威),前端不自行判定可用性。
// - 完整指令判定(染色与拦截共用同一判据):文本 = /name 或 /name␣参数,
//   name ∈ 可用清单(大小写不敏感);无参指令带参数视为普通文本。
// 全部为纯函数,单测见 app/tests/slash-commands.test.ts。

import type { AvailableCommandDto } from "@server/foundation/types/commands";

/** 前端指令形状 = 服务端可用清单条目(type-only 对齐,值经 API 下发)。 */
export type SlashCommandDto = AvailableCommandDto;

/** 推荐菜单触发判定:仅当文本以 "/" 开头且仍在敲指令名阶段(token 内无任何空白)
 *  时返回过滤词(小写,可为空串 = 刚敲 "/",展示全部);否则 null(菜单关闭)。
 *  出现空白即进入参数区,引导使命结束,菜单收起。 */
export function slashMenuQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const token = text.slice(1);
  if (/\s/.test(token)) return null;
  return token.toLowerCase();
}

/** 过滤推荐清单:前缀命中优先(组内保持注册表序),其次子串命中;大小写不敏感。
 *  空 query 返回全部。 */
export function filterSlashCommands(commands: readonly SlashCommandDto[], query: string): SlashCommandDto[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const prefixed: SlashCommandDto[] = [];
  const included: SlashCommandDto[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefixed.push(command);
    else if (name.includes(q)) included.push(command);
  }
  return [...prefixed, ...included];
}

export interface ParsedSlashCommand {
  command: SlashCommandDto;
  /** 指令名后的参数文本(已 trim;无参数为空串)。 */
  argument: string;
  /** 指令 token 在原文中的长度(含斜杠),镜像染色用。 */
  tokenLength: number;
}

/** 完整指令判定(拦截执行与染色共用):命中返回解析结果,否则 null(按普通文本发送)。 */
export function parseSlashCommand(
  text: string,
  commands: readonly SlashCommandDto[],
): ParsedSlashCommand | null {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const typedName = match[1]!;
  const command = commands.find((c) => c.name === typedName.toLowerCase());
  if (!command) return null;
  const argument = (match[2] ?? "").trim();
  if (argument && !command.hasArgument) return null;
  return { command, argument, tokenLength: 1 + typedName.length };
}
