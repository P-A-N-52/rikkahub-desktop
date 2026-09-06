import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

import { useAppStore } from "~/stores/app-store";

// tailwind-merge 不读我们的 CSS,只认它内置的 Tailwind 默认刻度表。app.css 的 @theme 里
// 自建的刻度必须在此登记,否则 `text-compact` 这类类名会被误判成【文字颜色】而不是【字号】——
// 与后面的真颜色同组冲突,直接从 class 串里被删掉,字号静默失效退回继承值(域13-4 回归的真根因:
// 标签页/选择器/Select 的 13px 全被吃掉退回根字号 16px,用户看到"字体变大")。
// 颜色类无需登记(未知 text-* 默认即按颜色处理),radius/font 沿用 Tailwind 默认键名亦无需登记。
// 由 app/tests/cn-theme-scale.test.ts 逐 token 行为锁定:app.css 新增刻度未登记即测试变红。
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["micro", "mini", "compact"],
      shadow: ["card", "elevated", "float", "strong"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function serverNow(): number {
  return Date.now() + useAppStore.getState().clockOffset;
}

export function extractThinkingTitle(text: string): string | null {
  const lines = text.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    const match = line.match(/^\*\*(.+?)\*\*$/);
    const title = match?.[1]?.trim();
    if (title) {
      return title;
    }
  }

  return null;
}
