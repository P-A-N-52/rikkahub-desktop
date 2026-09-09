// tools/format 纯函数单元测试（5.5 测试补强）。
// 工具调用的输入解析 / 输出序列化是模型工具循环的契约层：
// output 优先级（真实输出 > 审批回退）与 {error}/{pending} 历史载荷容错都在这里。
import { describe, expect, test } from "bun:test";

import {
  UNRESOLVED_TOOL_RESULT_TEXT,
  apiToolCallFromPart,
  openAiToolOutput,
  parseToolInput,
  partsToToolResultText,
  resolvedToolOutput,
  toolArgumentsJson,
  toolExecutionErrorPayload,
  toolOutputForApproval,
  toolResultTextForApi,
} from "./format";

describe("parseToolInput", () => {
  test("对象原样返回，JSON 字符串解析，垃圾输入返回空对象", () => {
    expect(parseToolInput({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolInput('{"q":"x"}')).toEqual({ q: "x" });
    expect(parseToolInput("not json")).toEqual({});
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput(42)).toEqual({});
    expect(parseToolInput('["array"]')).toEqual({});
  });
});

// 2026-09-07 内测报障(火山 MissingParameter input.arguments,第二问必炸)的归一化锁:
// ToolPart.input 是非可选 string,"参数缺失"落库形态是空串而非 undefined —— `?? "{}"`
// 接不住空串,会把 "" 原样发给上游。
describe("toolArgumentsJson", () => {
  test("空串/空白/非串一律归 \"{}\"（?? 接不住的空串正是 400 的直接触发物）", () => {
    expect(toolArgumentsJson("")).toBe("{}");
    expect(toolArgumentsJson("   ")).toBe("{}");
    expect(toolArgumentsJson("\n\t")).toBe("{}");
    expect(toolArgumentsJson(undefined)).toBe("{}");
    expect(toolArgumentsJson(null)).toBe("{}");
  });

  test("真实参数原样保留（去首尾空白，不改结构）", () => {
    expect(toolArgumentsJson('{"q":"x"}')).toBe('{"q":"x"}');
    expect(toolArgumentsJson('  {"q":1}  ')).toBe('{"q":1}');
    // 半成品 JSON 不做修复:参数解析容错归 parseToolInput,本函数只保证"非空"。
    expect(toolArgumentsJson('{"q":')).toBe('{"q":');
  });
});

describe("toolExecutionErrorPayload", () => {
  test("Error 带名称与消息（历史契约 {error} 裸对象形状）", () => {
    const payload = toolExecutionErrorPayload(new Error("boom"));
    expect(payload.error).toContain("[Error] boom");
    expect(payload.type).toBeUndefined();
  });

  test("非 Error 转字符串", () => {
    expect(toolExecutionErrorPayload("oops")).toEqual({ error: "oops" });
  });
});

describe("openAiToolOutput", () => {
  test("有 text part 时优先返回文本", () => {
    expect(openAiToolOutput([{ type: "text", text: "result" }])).toBe("result");
  });

  test("无文本时 JSON 序列化整个 output，空数组返回空串", () => {
    expect(openAiToolOutput([{ error: "boom" }])).toBe('[{"error":"boom"}]');
    expect(openAiToolOutput([])).toBe("");
  });
});

describe("toolOutputForApproval / resolvedToolOutput", () => {
  test("answered 返回答案，denied 返回带理由的错误 JSON，auto 返回空", () => {
    expect(toolOutputForApproval({ approvalState: { type: "answered", answer: "42" } })).toBe("42");
    const denied = toolOutputForApproval({ approvalState: { type: "denied", reason: "no" } });
    expect(JSON.parse(denied)).toEqual({ error: "Tool execution denied by user. Reason: no" });
    expect(toolOutputForApproval({ approvalState: { type: "auto" } })).toBe("");
  });

  test("denied 无理由时用占位文案", () => {
    const denied = toolOutputForApproval({ approvalState: { type: "denied", reason: "" } });
    expect(denied).toContain("No reason provided");
  });

  test("resolvedToolOutput 优先真实 output，无 output 回退审批状态", () => {
    expect(
      resolvedToolOutput({ output: [{ type: "text", text: "real" }], approvalState: { type: "answered", answer: "x" } }),
    ).toBe("real");
    expect(
      resolvedToolOutput({ output: [], approvalState: { type: "answered", answer: "fallback" } }),
    ).toBe("fallback");
  });
});

// 工具结果项发上游前的兜底(与 arguments 空串同源问题):function_call 与其结果项必须成对
// 且都有内容,空串会被严格端点(火山)按必填拒。占位文案与 pi 引擎中断补录共用常量。
describe("toolResultTextForApi", () => {
  test("有真实输出/审批派生输出时原样透传", () => {
    expect(toolResultTextForApi({ output: [{ type: "text", text: "real" }] })).toBe("real");
    expect(toolResultTextForApi({ output: [], approvalState: { type: "answered", answer: "42" } })).toBe("42");
  });

  test("既无输出又无审批派生时给确定性占位，绝不发空串", () => {
    expect(toolResultTextForApi({ output: [], approvalState: { type: "auto" } })).toBe(UNRESOLVED_TOOL_RESULT_TEXT);
    expect(toolResultTextForApi({})).toBe(UNRESOLVED_TOOL_RESULT_TEXT);
    expect(toolResultTextForApi({ output: [], approvalState: { type: "pending" } }).length).toBeGreaterThan(0);
  });
});

describe("partsToToolResultText", () => {
  test("只取 text part 以换行拼接", () => {
    expect(
      partsToToolResultText([
        { type: "text", text: "a" },
        { type: "image", url: "u" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});

describe("apiToolCallFromPart", () => {
  test("从 tool part 构造 OpenAI 工具调用回显", () => {
    const call = apiToolCallFromPart({ toolCallId: "id1", toolName: "search", input: '{"q":"x"}' });
    expect(call).toEqual({
      id: "id1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    });
  });

  test("缺 input 时回退到空对象串", () => {
    const call = apiToolCallFromPart({ toolCallId: "id2", toolName: "t" });
    expect(call.function.arguments).toBe("{}");
  });

  test("input 为空串时同样归 \"{}\"（旧 `?? \"{}\"` 会原样放行空串）", () => {
    expect(apiToolCallFromPart({ toolCallId: "id3", toolName: "t", input: "" }).function.arguments).toBe("{}");
  });
});
