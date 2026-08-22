// foundation/net.ts — 代理与网络工具
// 纪律：纯函数，不直接读取 state；调用方通过参数传入 ProxyConfig。

import { isRecord } from "./utils";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "./platform";
import type { ProxyConfig , ProxyMode } from "./types";

export let lastDetectedSystemProxy: string | undefined;
// 实际监听端口（Bun.serve 绑定后赋值）。端口顺延后可能与 preferredPort 不同，
// proxyStatusPayload 返回给前端用于显示"当前运行端口"。
let actualServingPort: number | undefined;
export function setActualServingPort(port: number) { actualServingPort = port; }
export function getActualServingPort(): number | undefined { return actualServingPort; }

export function parseProxyServerValue(value: string): string | undefined {
  if (!value) return undefined;
  // `ProxyServer` can be either a single endpoint ("127.0.0.1:7890") or per-protocol
  // ("http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=..."). Prefer the https= variant for
  // outbound API calls; fall back to http= or the bare endpoint.
  if (value.includes("=")) {
    const map = new Map<string, string>();
    for (const piece of value.split(";")) {
      const [k, v] = piece.split("=");
      if (k && v) map.set(k.trim().toLowerCase(), v.trim());
    }
    // P0-3: 不 fallback 到 socks=。Bun fetch 只支持 http/https 代理，把 SOCKS 端口当
    // HTTP 代理用会导致 CONNECT 握手挂起。注册表只有 socks= 时返回 undefined（等同无系统代理）。
    const target = map.get("https") ?? map.get("http");
    if (!target) return undefined;
    return /^https?:\/\//i.test(target) ? target : `http://${target}`;
  }
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

// R1-7:reg/gsettings 读取全部改异步(Bun.spawn),消灭"fetch 拦截器内同步 spawn 阻塞
// 事件循环数十 ms"的病灶。运行期唯一热路径入口是缓存读(readSystemProxy);这两个函数
// 只被启动预热、后台刷新和 settings/proxy/detect 端点调用。
async function runCommandText(cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

export async function readWindowsSystemProxy(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enable = await runCommandText(["reg", "query", key, "/v", "ProxyEnable"]);
    if (enable.exitCode !== 0) return undefined;
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enable.stdout)) return undefined;
    const server = await runCommandText(["reg", "query", key, "/v", "ProxyServer"]);
    if (server.exitCode !== 0) return undefined;
    const match = server.stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!match) return undefined;
    return parseProxyServerValue(match[1].trim());
  } catch {
    return undefined;
  }
}

// Linux 桌面 GNOME 代理读取（gsettings）。仅处理 mode='manual'（明确主机端口）；
// 'none' 返回 undefined；'auto'（PAC）不支持（我们不实现 PAC 解析）。
// KDE 暂不支持，用户可在 UI 手动填代理（mode=manual）。
export async function readGnomeProxy(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const get = async (args: string[]) => (await runCommandText(["gsettings", ...args])).stdout.trim();
    const modeRaw = await get(["get", "org.gnome.system.proxy", "mode"]);
    if (!modeRaw || modeRaw === "'none'") return undefined;
    if (modeRaw !== "'manual'") return undefined; // 'auto'（PAC）未实现
    const host = (await get(["get", "org.gnome.system.proxy.http", "host"])).replace(/^'|'$/g, "");
    const port = await get(["get", "org.gnome.system.proxy.http", "port"]);
    if (!host || !port || host === "''" || port === "0") return undefined;
    return `http://${host}:${port}`;
  } catch {
    return undefined;
  }
}

// 专题10-②:PAC(自动配置脚本)存在性探测。应用不解析 PAC(实现成本高、收益低),本函数
// 仅供"检测系统代理"按钮的诊断提示:常规系统代理未检出但存在 PAC 配置时,告诉用户
// 去代理工具查 HTTP 端口手动填写,而不是留下"未检测到系统代理"的死胡同。
// 不进代理解析主链路(resolveEffectiveProxy),探测失败一律视作无 PAC。
export async function detectSystemPacUrl(): Promise<string | undefined> {
  try {
    if (RUNTIME_PLATFORM === "win") {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      const res = await runCommandText(["reg", "query", key, "/v", "AutoConfigURL"]);
      if (res.exitCode !== 0) return undefined;
      const match = res.stdout.match(/AutoConfigURL\s+REG_SZ\s+([^\r\n]+)/i);
      return match?.[1]?.trim() || undefined;
    }
    if (RUNTIME_PLATFORM === "linux" && !RUNNING_IN_CONTAINER) {
      const mode = (await runCommandText(["gsettings", "get", "org.gnome.system.proxy", "mode"])).stdout.trim();
      if (mode !== "'auto'") return undefined;
      const url = (await runCommandText(["gsettings", "get", "org.gnome.system.proxy", "autoconfig-url"])).stdout
        .trim()
        .replace(/^'|'$/g, "");
      // GNOME mode='auto' 即 PAC 模式;url 可能为空(WPAD 自动发现),仍算存在 PAC。
      return url || "wpad";
    }
  } catch {
    // 纯诊断增强,探测异常绝不能影响检测主流程。
  }
  return undefined;
}

export async function detectSystemProxy(): Promise<string | undefined> {
  if (RUNTIME_PLATFORM === "win") return readWindowsSystemProxy();
  if (RUNTIME_PLATFORM === "linux" && !RUNNING_IN_CONTAINER) return readGnomeProxy();
  return undefined;
}

let systemProxyCache: { value: string | undefined; ts: number } | null = null;
export const SYSTEM_PROXY_TTL_MS = 2000;
let systemProxyRefreshInFlight = false;

function scheduleSystemProxyRefresh(): void {
  if (systemProxyRefreshInFlight) return;
  systemProxyRefreshInFlight = true;
  void detectSystemProxy()
    .then((value) => { systemProxyCache = { value, ts: Date.now() }; })
    .finally(() => { systemProxyRefreshInFlight = false; });
}

/** R1-7:启动时(首个业务出站 fetch 之前,见 bootstrap 第 2 步)预热一次缓存,
 *  之后 readSystemProxy 永不阻塞。 */
export async function primeSystemProxyCache(): Promise<void> {
  systemProxyCache = { value: await detectSystemProxy(), ts: Date.now() };
}

/** R1-7:同步读缓存(fetch 拦截器 per-request 调用,不能阻塞)。TTL 过期返回陈值并触发
 *  后台单飞刷新(stale-while-revalidate)——旧实现 TTL 过期后的首个出站 fetch 要同步
 *  spawn 两次 reg query,阻塞事件循环数十 ms,多路流式并发时表现为周期性微卡。
 *  冷缓存(未预热,常规启动流程不会发生)返回 undefined 并触发后台刷新,该次请求按直连走。 */
export function readSystemProxy(): string | undefined {
  if (!systemProxyCache) {
    scheduleSystemProxyRefresh();
    return undefined;
  }
  if (Date.now() - systemProxyCache.ts >= SYSTEM_PROXY_TTL_MS) scheduleSystemProxyRefresh();
  return systemProxyCache.value;
}

export function composeProxyUrl(base: string, username: string, password: string): string {
  const trimmed = base.trim();
  if (!trimmed) return "";
  if (!username && !password) return trimmed;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    // The WHATWG URL setter encodes the value itself — don't pre-encode or we end up
    // double-escaping characters like "@" in `user@example.com` into "user%2540example.com".
    if (username) url.username = username;
    if (password) url.password = password;
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function resolveEffectiveProxy(cfg: ProxyConfig): { url: string | undefined; source: "manual" | "system" | "env" | "none" } {
  const mode = cfg?.mode ?? "auto";

  if (mode === "direct") {
    // 强制直连：完全忽略系统代理声明，用户显式选择的逃生口
    return { url: undefined, source: "none" };
  }

  if (mode === "env") {
    // 完全由 env 控制（Docker）：读当前 env 值用于展示，不由我们写入（applyEffectiveProxy 也是 no-op）
    const envUrl = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
    return { url: envUrl || undefined, source: envUrl ? "env" : "none" };
  }

  if (mode === "manual") {
    const manual = cfg?.url?.trim();
    if (manual) {
      return { url: composeProxyUrl(manual, cfg!.username ?? "", cfg!.password ?? ""), source: "manual" };
    }
    return { url: undefined, source: "none" };
  }

  // mode === "auto": 跟随系统代理（Windows 注册表 / GNOME gsettings）
  const system = readSystemProxy();
  lastDetectedSystemProxy = system;
  if (system) return { url: system, source: "system" };
  return { url: undefined, source: "none" };
}

export function applyEffectiveProxy(cfg: ProxyConfig) {
  // 代理的 per-request 应用由 installProxyFetchInterceptor 安装的拦截器负责。
  // 此函数仅做日志输出，保留调用点不变（updateSettings / settings/proxy POST 都调它）。
  const mode = cfg?.mode ?? "auto";
  if (mode === "env") {
    const envUrl = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
    console.log(envUrl ? `[proxy] env: ${redactProxyForLog(envUrl)}` : "[proxy] env: direct (no HTTPS_PROXY)");
    return;
  }
  const { url, source } = resolveEffectiveProxy(cfg);
  console.log(url ? `[proxy] ${source}: ${redactProxyForLog(url)}` : "[proxy] direct (no proxy)");
}

// bypassRules 匹配（逻辑移植自 opencode proxy-from-env 的 shouldProxy + kelivo CIDR）。
// localhost/127.0.0.1/::1 永远 bypass（硬编码，即使没配 rules）；用户 rules 支持精确域名 /
// 通配（*.example.com / .example.com）/ host:port 端口限定 / IPv4 CIDR 网段（10.0.0.0/8）。
// CIDR 仅当 target 是 IP 字面量时生效（域名请求时拿到的是域名不是 IP，CIDR 没法判断）。
export function shouldBypassProxy(targetUrl: string, userRules: string): boolean {
  let hostname: string;
  let port: number;
  try {
    const u = new URL(targetUrl);
    hostname = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
  } catch {
    return false; // URL 解析不出，不 bypass（让请求正常发出，由调用方处理错误）
  }
  const noProxy = `localhost,127.0.0.1,::1,${userRules}`.toLowerCase();
  for (const rule of noProxy.split(/[,\s]/)) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    const parsed = trimmed.match(/^(.+):(\d+)$/);
    const rh = parsed ? parsed[1] : trimmed;
    const rp = parsed ? parseInt(parsed[2], 10) : 0;
    if (rp && rp !== port) continue; // 端口限定的规则，端口不匹配跳过
    if (rh === "*") return true; // 全 bypass
    if (rh.includes("/")) {
      // CIDR 网段（10.0.0.0/8）：target 必须是 IPv4 字面量
      if (ipInCidr(hostname, rh)) return true;
      continue;
    }
    if (rh.startsWith("*")) {
      // *.example.com 匹配 example.com 及子域
      if (hostname === rh.slice(2) || hostname.endsWith(rh.slice(1))) return true;
    } else if (rh.startsWith(".")) {
      // .example.com 匹配子域
      if (hostname.endsWith(rh)) return true;
    } else {
      if (hostname === rh) return true;
    }
  }
  return false;
}

// IPv4 点分十进制 → 无符号 32 位整数。非法格式返回 null。
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

// IPv4 CIDR 网段匹配（移植自 kelivo _matchesCidr，简化为仅 IPv4）。
// cidr 格式 "10.0.0.0/8"；prefix 0 = 全匹配，32 = 精确 IP。
export function ipInCidr(ip: string, cidr: string): boolean {
  const ci = cidr.indexOf("/");
  if (ci < 0) return false;
  const net = cidr.slice(0, ci).trim();
  const prefix = parseInt(cidr.slice(ci + 1).trim(), 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : ((1 << prefix) - 1) << (32 - prefix);
  return ((ipInt & mask) >>> 0) === ((netInt & mask) >>> 0);
}

// Bun fetch 在进程首次网络请求时快照 HTTPS_PROXY/HTTP_PROXY/NO_PROXY env 并永久锁定
// （实测 Bun 1.3.13；1.4.0 经 scripts/proxy-behavior-smoke.ts 复核锁仍在、direct/manual 分流
// 与错误分类正则均未漂移）。本函数在 server 启动早期（首次 fetch 前）安装拦截：
//   - 非容器部署：清空 env 防 Bun 锁定旧代理
//   - 容器部署（mode=env）：保留 docker 注入的 HTTPS_PROXY，让 Bun 快照它
//   - 替换 globalThis.fetch，per-request 按当前代理状态显式传 proxy 选项
export function installProxyFetchInterceptor(getProxyConfig: () => ProxyConfig): void {
  if (!RUNNING_IN_CONTAINER) {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    // 调用方已显式传 proxy（如 /settings/proxy/test 端点）：尊重，不拦截
    const explicitProxy = (init as (RequestInit & { proxy?: string }) | undefined)?.proxy;
    if (explicitProxy !== undefined) {
      return originalFetch(input, init);
    }
    let target = "";
    if (typeof input === "string") target = input;
    else if (input instanceof URL) target = input.href;
    else if (input instanceof Request) target = input.url;
    const cfg = getProxyConfig();
    const mode = cfg?.mode ?? "auto";
    let proxy: string | undefined;
    // env 模式（Docker）：不注入，让 Bun 用启动时快照的 docker env。
    // direct：强制直连。其余（auto/manual）：按当前 resolveEffectiveProxy + bypass 决定。
    if (mode !== "env" && mode !== "direct") {
      const { url } = resolveEffectiveProxy(cfg);
      if (url && !shouldBypassProxy(target, cfg?.bypassRules ?? "")) {
        proxy = url;
      }
    }
    if (proxy) {
      return originalFetch(input, { ...(init as RequestInit), proxy } as RequestInit & { proxy: string });
    }
    return originalFetch(input, init);
  } as typeof fetch;
}

export function redactProxyForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

// P1-6: 识别 fetch 错误是否疑似代理问题（ECONNREFUSED/ECONNRESET/407/CONNECT 失败等）。
// 有代理时返回友好提示（替代泛化"请求失败：..."），无代理返回 null（走原"请求失败"逻辑）。
// 这是横向覆盖所有 provider 流式调用的最小注入点 —— send 端点 catch 调它即可。
export function classifyProxyError(err: unknown, cfg: ProxyConfig): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/ECONNREFUSED|ECONNRESET|EPIPE|_tunnel|proxy connect|407|Unable to connect|fetch failed/i.test(msg)) {
    return null;
  }
  const { url, source } = resolveEffectiveProxy(cfg);
  if (!url && source === "none") return null; // 无代理，是普通网络/API 问题，不冒充代理错误
  const display = url ? redactProxyForLog(url) : "系统代理";
  return `代理连接失败 (${display}) —— 请检查代理地址 / 端口 / 密码是否正确，或在 设置 → 代理 中切换为「直连」模式。\n[原始错误] ${msg}`;
}

// 测试端点（供应商 / 搜索 / 图片 / 流式）共用的错误信息构造：命中代理错误给友好提示，
// 否则用原始消息。供应商/搜索测试的请求路径与对话相同（都走 installProxyFetchInterceptor），
// 但各自的 catch 只报"请求未能发送"，代理错误被埋没在一堆可能原因里 —— 套这层让代理问题
// 在所有页面都给出一致的精准提示。
export function friendlyRequestError(err: unknown, cfg: ProxyConfig): string {
  return classifyProxyError(err, cfg) ?? (err instanceof Error ? err.message : String(err));
}

export function proxyStatusPayload(cfg: ProxyConfig) {
  const { url, source } = resolveEffectiveProxy(cfg);
  // Strip credentials from the URL we send back to the UI — the UI shows the username/password
  // fields separately, no need to echo them in the "active proxy" footer.
  let displayUrl: string | undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      displayUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      displayUrl = url;
    }
  }
  return {
    activeUrl: displayUrl ?? null,
    source, // "manual" | "system" | "env" | "none"
    detectedSystemProxy: lastDetectedSystemProxy ?? null,
    // 当前 mode 与容器标记，前端据此决定 UI 分支（如 containerMode 锁定 mode=env 只读）
    mode: cfg?.mode ?? "auto",
    containerMode: RUNNING_IN_CONTAINER,
    // 实际运行端口（顺延后可能与 preferredPort 不同），前端口 Card 显示
    runningPort: actualServingPort ?? null,
  };
}

export function normalizeProxyConfig(value: unknown): ProxyConfig {
  const raw = isRecord(value) ? value : {};
  const url = String(raw.url ?? "").trim();
  const username = String(raw.username ?? "");
  const password = String(raw.password ?? "");
  const bypassRules = String(raw.bypassRules ?? "").trim();
  const rawMode = raw.mode;
  let mode: ProxyMode;
  if (rawMode === "auto" || rawMode === "manual" || rawMode === "direct" || rawMode === "env") {
    mode = rawMode;
  } else {
    // 旧 settings 无 mode 字段(或值非法)→ 按平台推断, 保证旧行为兼容:
    //   有 url → manual; 无 url + 容器 → env(docker 默认); 无 url + 桌面 → auto(跟随系统)
    if (url) mode = "manual";
    else if (RUNNING_IN_CONTAINER) mode = "env";
    else mode = "auto";
  }
  return { mode, url, username, password, bypassRules };
}

// Port setting: integer in [1, 65535] or null (auto). Anything out of range / wrong type
// normalizes back to null so a corrupt state.json can never wedge the server on an invalid port.
export function normalizePreferredPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n >= 1 && n <= 65535) return n;
  }
  return null;
}

// ── 统一出站 fetch(全面审查 6-2)────────────────────────────────
// 外围域(search/scrape/ln 脚本/生图/TTS/ASR/provider 测试/更新检查)此前全部裸 fetch,
// 上游半开连接/黑洞路由时工具调用与"测试连接"永不返回,挂起的 promise 永久泄漏。
// 统一走本包装:默认 30s 总时长超时;调用方已有 signal(生成中止等)时两者并联,
// 任一触发即中止。流式聊天主链路(自带生成中止 signal,可合法长跑)与大文件下载
// (进度流,总时长上限无意义)不适用本包装。
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export interface FetchWithTimeoutInit extends RequestInit {
  /** 总时长上限;默认 DEFAULT_OUTBOUND_TIMEOUT_MS。注意覆盖响应体读取全程,慢任务给足余量。 */
  timeoutMs?: number;
}

export function fetchWithTimeout(url: string | URL, init: FetchWithTimeoutInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS, signal, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...rest, signal: combined });
}

/** 用空闲超时包裹一次异步读取(通常是 reader.read()):超 timeoutMs 未 settle 即 reject,
 *  让上游黑洞连接及时报错释放,而非永久悬挂。原 promise 在超时后仍挂着(JS 无法取消),
 *  但错误已向上传播,调用栈随之解开;若需真正断开底层连接,调用方在 catch 里 abort。
 *  原为 inference-engine/tool-loop 的 R3-1 能力,专题7 下沉到此供全库复用
 *  (LLM 流式读取、供应商测试流、更新包下载流)。 */
export function readWithIdleTimeout<T>(read: () => Promise<T>, timeoutMs: number, errorMessage?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    read(),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(errorMessage ?? `流空闲超时:${Math.round(timeoutMs / 1000)}s 未收到上游数据`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
