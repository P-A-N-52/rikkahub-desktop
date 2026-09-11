// api/static.ts — 内嵌 web-ui 静态文件服务（SPA fallback 与缓存策略）
// 纪律：只负责静态资源定位与 Cache-Control；API 路由在 server.ts / api/handlers。

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resourcePaths, resolveStaticRoot } from "../foundation/paths";
import { mime } from "./request";

// 批次二 R7-1(纵深防御):Tauri 壳窗口加载的是本服务的 http://127.0.0.1 页面,
// tauri.conf.json 的 csp 只对 tauri://asset 协议生效,对 remote URL 完全不适用——
// 唯一有效的下发点是这里的 HTML 响应头(同时天然覆盖 Web 托管/反代模式)。
// 脚本注入的主防线是前端 Markdown 的 rehype-sanitize(见 markdown.tsx);script-src
// 在这里不能收紧:① 构建产物 index.html 含 Vite 生成的内联 <script>;② workbench 的
// HTML 预览 iframe(sandbox="allow-scripts" + srcDoc)按设计执行模型生成的任意内联
// 脚本,而 srcdoc 文档继承父页 CSP。故取零特性风险的最小集:
//   object-src 'none'   —— 禁 <object>/<embed> 注入
//   base-uri 'self'     —— 禁 <base href> 劫持相对路径(API/资源请求被重定向到攻击者域)
//   form-action 'self'  —— 禁表单向外域提交(凭据/内容外发)
//   frame-ancestors 'self' —— Web 托管模式防点击劫持(Tauri 顶层窗口不受影响)
const HTML_CSP = "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

export async function routeStatic(url: URL) {
  const staticRoot = resolveStaticRoot();
  if (!staticRoot) {
    return new Response("web-ui is not built. Run `cd web-ui && bun install && bun run build`.", { status: 200 });
  }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = resolve(staticRoot, requested);
  // 批次二 R1-3:前缀校验必须带路径分隔符——裸 startsWith(staticRoot) 会放行同前缀
  // 兄弟目录(/x/build/client2/... 通过 /x/build/client 的校验),是经典穿越模式。
  if (target.startsWith(staticRoot + sep) && existsSync(target)) {
    const contentType = mime(target);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": staticCacheControl(url.pathname, target),
    };
    if (contentType.startsWith("text/html")) headers["Content-Security-Policy"] = HTML_CSP;
    return new Response(Bun.file(target), { headers });
  }
  // 打包资源丢失需要以真实失败暴露，不能把 SPA HTML 当作成功的 JS/CSS/图标响应。
  if (resourcePaths.explicit && (url.pathname.startsWith("/assets/") || /\.[^/]+$/.test(url.pathname))) {
    return new Response(`Bundled resource not found: ${url.pathname}`, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // SPA fallback (index.html): 绝不缓存。覆盖安装后 WebView2 每次都拿最新的 index.html,
  // 它引用的 hash 化 css/js 会自然跟到新版本,彻底杜绝"装了新版还在跑旧前端"的缓存污染。
  return new Response(Bun.file(join(staticRoot, "index.html")), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": HTML_CSP,
    },
  });
}

// 静态资源 Cache-Control 策略,解决覆盖安装时 WebView2 缓存旧前端的问题:
//   index.html → no-store:唯一被直接请求的"无 hash"入口,只要它最新,引用的
//               /assets/*.<hash>.css|js 会自动指向新版本。
//   /assets/* → immutable + 1 年:Vite 按内容 hash 命名,内容变则文件名变,可安全永久缓存。
//   其余(favicon 等,无 hash)→ 1 小时短缓存兜底。
function staticCacheControl(pathname: string, target: string): string {
  if (target.endsWith("index.html") || pathname === "/") return "no-store";
  if (pathname.startsWith("/assets/") && /\.(css|js|mjs|woff2?|ttf|otf|wasm)$/i.test(target)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}
