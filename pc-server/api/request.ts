// api/request.ts — HTTP 请求/响应辅助（json/error/readJson/mime）
// 纪律：纯辅助函数，不依赖业务状态。

import type { JsonValue } from "../foundation/types";

export function json(data: JsonValue | object, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/** errorCode:业务错误码(foundation/errors.ts CodedError 通道)——前端按码查 i18n
 *  文案,message 是兜底。不传则响应结构与旧版完全一致(向后兼容)。 */
export function error(message: string, status = 400, errorCode?: string) {
  return json({ error: message, code: status, ...(errorCode ? { errorCode } : {}) }, { status });
}

/** 4-6:非空但不可解析的 body 抛出,routeApi 统一映射 400。此前静默返回 {},
 *  坏 body 让写端点拿默认值继续执行(如 s3/delete 收到坏 JSON 会当 fileName 为空)。 */
export class JsonBodyError extends Error {}

export async function readJson<T>(request: Request): Promise<T> {
  if (request.headers.get("content-length") === "0") return {} as T;
  const text = await request.text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JsonBodyError("Malformed JSON body");
  }
}

export function mime(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  // R1-8:自定义字体(上传端点接受 ttf/otf/woff/woff2 四种,见 system.ts FONT_EXTENSIONS_SET)
  // 此前以 octet-stream 兜底——字体浏览器容忍(仅告警),但 .wasm 一旦引入会因
  // instantiateStreaming 强制 MIME 校验而直接失败,提前补齐。
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

/** R5-2:SSE 响应标准头。X-Accel-Buffering: no 让 nginx 等反向代理对本响应自动关闭
 *  proxy_buffering——否则事件被攒进缓冲区批量放行,流式表现为"卡住后一次性倾倒",
 *  与 33ms 合并广播的丝滑目标背道而驰。全部 text/event-stream 响应(events/详情流/
 *  provider 流式测试/更新下载/WebDAV/S3 进度×4)共用此构造,新增 SSE 端点也从这里拿头。 */
export function sseHeaders(overrides?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...overrides,
  };
}
