// commands/registry.test.ts — 指令注册表可用性矩阵解析
import { describe, expect, test } from "bun:test";

import { COMMAND_REGISTRY, resolveAvailableCommands } from "./registry";

describe("指令注册表:定义形状约束", () => {
  test("指令名全局唯一且为小写英文(用户输入的 /name,不翻译)", () => {
    const names = COMMAND_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("可用性矩阵解析(白名单缺省禁用)", () => {
  test("对话模式(chat):/compact 可用", () => {
    const commands = resolveAvailableCommands("chat");
    expect(commands).toEqual([{ name: "compact", hasArgument: true, executionTarget: "server" }]);
  });

  test("pi 工作区:/compact 可用(绑 pi 原生 compaction)", () => {
    expect(resolveAvailableCommands("pi").map((c) => c.name)).toContain("compact");
  });

  test("矩阵未声明的引擎缺省禁用(dsh/codex 未点亮)", () => {
    expect(resolveAvailableCommands("dsh")).toEqual([]);
    expect(resolveAvailableCommands("codex")).toEqual([]);
  });

  test("开放枚举:未来任意新引擎 kind 缺省禁用,强制显式评估绑定", () => {
    expect(resolveAvailableCommands("some-future-engine")).toEqual([]);
  });
});
