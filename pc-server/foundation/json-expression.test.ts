// foundation/json-expression.test.ts — 余额取值表达式 DSL 单测(对齐 Android JsonExpression.kt)。
import { describe, expect, test } from "bun:test";
import { evaluateJsonExpr, isJsonExprValid } from "./json-expression";
import { setState } from "../persistence/json-store";
import { fetchProviderBalance } from "../model-providers/checks";

describe("evaluateJsonExpr — 路径导航", () => {
  const root = {
    data: { total_credits: 100.5, total_usage: 20.25, available_balance: 80 },
    balance: 42,
    balance_infos: [{ total_balance: "66.66" }],
    nested: { arr: [1, 2, { v: "x" }] },
  };

  test("单字段", () => expect(evaluateJsonExpr("balance", root)).toBe("42"));
  test("嵌套路径", () => expect(evaluateJsonExpr("data.available_balance", root)).toBe("80"));
  test("数组下标", () => expect(evaluateJsonExpr("balance_infos[0].total_balance", root)).toBe("66.66"));
  test("数组嵌套取值", () => expect(evaluateJsonExpr("nested.arr[2].v", root)).toBe("x"));
  test("缺失字段解析为空字符串", () => expect(evaluateJsonExpr("data.missing", root)).toBe(""));
  test("越界索引解析为空字符串", () => expect(evaluateJsonExpr("balance_infos[9]", root)).toBe(""));
  test("空表达式无字段可取,解析为空字符串(下游判为未命中)", () => {
    expect(evaluateJsonExpr("", { a: 1 })).toBe("");
  });
});

describe("evaluateJsonExpr — 算术与拼接", () => {
  const root = { data: { total_credits: 100.5, total_usage: 20.25 }, a: 10, b: 4 };

  test("减法(issue5 OpenRouter 净余额)", () =>
    expect(evaluateJsonExpr("data.total_credits - data.total_usage", root)).toBe("80.25"));
  test("加法", () => expect(evaluateJsonExpr("a + b", root)).toBe("14"));
  test("乘法", () => expect(evaluateJsonExpr("a * b", root)).toBe("40"));
  test("乘法别名 x", () => expect(evaluateJsonExpr("a x b", root)).toBe("40"));
  test("除法", () => expect(evaluateJsonExpr("a / b", root)).toBe("2.5"));
  test("优先级:乘除先于加减", () => expect(evaluateJsonExpr("a + b * 2", root)).toBe("18"));
  test("括号改变优先级", () => expect(evaluateJsonExpr("(a + b) * 2", root)).toBe("28"));
  test("一元负号", () => expect(evaluateJsonExpr("-a", root)).toBe("-10"));
  test("数字字面量", () => expect(evaluateJsonExpr("3.14", root)).toBe("3.14"));
  test("字符串拼接 ++", () => expect(evaluateJsonExpr('"余额:" ++ balance', { balance: 42 })).toBe("余额:42"));
});

describe("evaluateJsonExpr — 各预置供应商 resultPath", () => {
  test("OpenRouter 减法(数值经两位小数化简,对齐 Android)", () =>
    expect(evaluateJsonExpr("data.total_credits - data.total_usage", { data: { total_credits: 10, total_usage: 1.234 } })).toBe("8.77"));
  test("Vercel AI Gateway balance", () => expect(evaluateJsonExpr("balance", { balance: 7 })).toBe("7"));
  test("硅基流动 data.totalBalance", () => expect(evaluateJsonExpr("data.totalBalance", { data: { totalBalance: "12.3" } })).toBe("12.3"));
  test("月之暗面 data.available_balance", () =>
    expect(evaluateJsonExpr("data.available_balance", { data: { available_balance: 55 } })).toBe("55"));
  test("DeepSeek balance_infos[0].total_balance", () =>
    expect(evaluateJsonExpr("balance_infos[0].total_balance", { balance_infos: [{ total_balance: "88.88" }] })).toBe("88.88"));
});

describe("isJsonExprValid — 合法性校验(供前端红标)", () => {
  test("合法路径", () => expect(isJsonExprValid("data.total_credits")).toBe(true));
  test("合法运算", () => expect(isJsonExprValid("data.a - data.b")).toBe(true));
  test("非法:未闭合字符串", () => expect(isJsonExprValid('"abc')).toBe(false));
  test("非法:残缺运算", () => expect(isJsonExprValid("a + ")).toBe(false));
  test("非法:意外字符", () => expect(isJsonExprValid("a @ b")).toBe(false));
});

// 端到端:起真实本地 HTTP 端点当 OpenRouter,跑完整 fetchProviderBalance 链路
// (fetch → DSL 求值 → 两位小数格式化),锁定 issue5 的回归。
describe("fetchProviderBalance 端到端(issue5)", () => {
  async function withOpenRouterStub(resultPath: string, run: (p: any) => Promise<string>) {
    const { defaultState } = await import("../app-config/defaults");
    setState(defaultState());
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 13.78 } }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      const provider = {
        type: "openai",
        baseUrl: `http://127.0.0.1:${srv.port}`,
        apiKey: "k",
        balanceOption: { enabled: true, apiPath: "/credits", resultPath },
      } as any;
      return await run(provider);
    } finally {
      srv.stop(true);
    }
  }

  test("减法算出净余额并两位小数化", async () => {
    const value = await withOpenRouterStub("data.total_credits - data.total_usage", async (p) =>
      (await fetchProviderBalance(p)).value,
    );
    expect(value).toBe("36.22");
  });

  test("单字段路径照常", async () => {
    const value = await withOpenRouterStub("data.total_credits", async (p) =>
      (await fetchProviderBalance(p)).value,
    );
    expect(value).toBe("50.00");
  });

  test("非法表达式给友好错误而非崩溃", async () => {
    await expect(
      withOpenRouterStub("data.total_credits -", (p) => fetchProviderBalance(p).then((r) => r.value)),
    ).rejects.toThrow(/余额结果路径表达式无效/);
  });
});
