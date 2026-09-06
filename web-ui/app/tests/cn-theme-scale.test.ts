// cn() 与 app.css @theme 自建刻度的一致性锁(域13-4 回归防线)。
//
// tailwind-merge 只认内置 Tailwind 刻度表:@theme 里自建的 --text-*/--shadow-* 若未在
// cn() 的 extendTailwindMerge 里登记,`text-compact` 会被当成【文字颜色】,与同串里真正的
// 颜色类冲突而被删除 —— 字号静默失效、退回继承值。这正是"标签页/选择器字体变大"的根因。
//
// 两道锁:①逐 token 验证与颜色/阴影共存时不被吞;②从 app.css 抽出全部自建刻度键,
// 与 cn() 的登记表比对——app.css 新增一档而忘了登记,本测试立刻变红。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { cn } from "~/lib/utils";

const APP_CSS = join(import.meta.dir, "..", "app.css");
const UTILS_TS = join(import.meta.dir, "..", "lib", "utils.ts");

/** app.css 的 `@theme inline { ... }` 块正文(自建刻度只在此声明)。 */
function readThemeBlock(): string {
  const css = readFileSync(APP_CSS, "utf8");
  const start = css.indexOf("@theme inline {");
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** @theme 里 `--<ns>-<key>` 的 key 集合(如 ns=text → micro/mini/compact)。 */
function themeKeys(ns: string): string[] {
  const keys = new Set<string>();
  for (const m of readThemeBlock().matchAll(new RegExp(`^\\s*--${ns}-([a-z0-9-]+)\\s*:`, "gm"))) {
    keys.add(m[1]!);
  }
  return [...keys].sort();
}

/** cn() 里 extendTailwindMerge 某命名空间的登记键。 */
function registeredKeys(ns: string): string[] {
  const src = readFileSync(UTILS_TS, "utf8");
  const m = src.match(new RegExp(`${ns}:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

/** Tailwind 默认自带、无需登记的键(与自建键混在同一 @theme 块里)。 */
const BUILTIN = {
  text: new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]),
  shadow: new Set(["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "none", "inner"]),
};

describe("cn 保留自建字号刻度", () => {
  // 五处内测报障点的真实类串形态:字号 token 与文字颜色同串。
  test.each([
    ["一级标签", "text-compact font-medium text-[var(--ds-text-primary)]", "text-compact"],
    ["二级标签", "text-compact bg-[var(--ds-on-surface)] text-[var(--ds-text-primary)]", "text-compact"],
    ["模型选择器", "text-compact font-medium text-[var(--ds-icon)]", "text-compact"],
    ["Select 触发器", "px-[10px] py-2 text-compact text-[var(--ds-text-primary)]", "text-compact"],
    ["时间戳", "text-mini text-muted-foreground", "text-mini"],
    ["角标", "text-micro font-medium text-warning", "text-micro"],
  ])("%s 的字号不被当作颜色吞掉", (_name, input, expected) => {
    expect(cn(input)).toContain(expected);
  });

  test("颜色写在字号之后也两者并存", () => {
    const out = cn("text-muted-foreground text-micro");
    expect(out).toContain("text-micro");
    expect(out).toContain("text-muted-foreground");
  });

  test("仍能被同组预设字号正确覆盖(后者胜)", () => {
    expect(cn("text-compact text-base")).toBe("text-base");
    expect(cn("text-sm text-mini")).toBe("text-mini");
  });

  test("自建阴影刻度同样成组去重", () => {
    expect(cn("shadow-card shadow-none")).toBe("shadow-none");
    expect(cn("shadow-card hover:shadow-elevated")).toBe("shadow-card hover:shadow-elevated");
  });
});

describe("app.css 自建刻度全部登记在 cn", () => {
  test.each([["text"], ["shadow"]])("--%s-* 无遗漏", (ns) => {
    const custom = themeKeys(ns).filter((k) => !BUILTIN[ns as "text" | "shadow"].has(k));
    expect(registeredKeys(ns)).toEqual(custom);
  });
});
