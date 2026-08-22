// scripts/proxy-behavior-smoke.ts — Bun 运行时 fetch 代理行为重验证(升级 Bun 后必跑)。
//   bun run scripts/proxy-behavior-smoke.ts   (在 pc-server 目录下)
//
// 三条断言对应 net.ts 拦截器设计的三个根基,每条都用「本地可控靶标」做决定性判定,
// 不依赖外网/系统代理是否在线,故在任何机器与 CI 上结论一致:
//
//   A. env 快照锁是否仍在(对照 net.ts:274 注释):
//      Bun fetch 在「进程首次网络请求」时快照 *_PROXY env 并锁定。判定法:
//      装好拦截器后发一次请求(触发快照),随后运行时把 HTTPS_PROXY 改指一个
//      「必死的本地端口」。若后续 direct 请求仍命中真实代理(而非死代理),
//      说明运行时的 env 变更未被采信 → 锁仍在;若改打向死代理 → 锁已解除。
//      (快照锁是 net.ts:274 设计的根基;若变了 = 重大发现,停下上报。)
//
//   B. 拦截器 per-request 注入是否按 mode 正确分流:
//      同一进程、同一 globalThis.fetch,仅切换 getProxyConfig() 的返回值:
//      direct 模式必须无视「会被采信的代理」直连真靶;manual 模式必须把请求
//      送进指定代理。证明拦截器在 1.4 下仍能 per-request 覆盖 Bun 的 env 决策。
//
//   C. fetch 网络错误分类正则是否仍命中(classifyProxyError,对 A2):
//      fetch 一个必死的本地端口触发 ECONNREFUSED,确认错误形态(code/message)
//      仍被 net.ts 的正则捕获,友好提示照常产出。
import { installProxyFetchInterceptor, classifyProxyError } from "../foundation/net";
import type { ProxyConfig } from "../foundation/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ok  " + name);
  else { failures++; console.error("FAIL  " + name + (detail !== undefined ? "  →  " + JSON.stringify(detail) : "")); }
}

// ── 本地靶标 ────────────────────────────────────────────────────────────────
// origin: 真实目标,回 204。proxy: 记录收到的请求并回 200,据此判断请求有没有被代理。
// deadProxy: 仅占用一个端口后立刻关闭,得到一个「必 ECONNREFUSED」的端口。
const seenByProxy: string[] = [];
const proxy = Bun.serve({
  port: 0,
  fetch(req) { seenByProxy.push(req.url); return new Response("via-proxy", { status: 200 }); },
});
const origin = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
const deadHolder = Bun.serve({ port: 0, fetch: () => new Response("x") });
const deadPort = deadHolder.port;
deadHolder.stop(true);

const originUrl = `http://127.0.0.1:${origin.port}/target`;
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const deadUrl = `http://127.0.0.1:${deadPort}/`;

async function statusOf(url: string): Promise<number | "ERR"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return "ERR";
  }
}

console.log(`[proxy-behavior] Bun ${Bun.version}  origin=:${origin.port} proxy=:${proxy.port} dead=:${deadPort}`);

// 默认 direct 配置:安装拦截器但不注入任何代理(非容器下还会清空 *_PROXY env)。
const directCfg: ProxyConfig = { mode: "direct" } as ProxyConfig;
let cfg = directCfg;
installProxyFetchInterceptor(() => cfg);

// ── A. env 快照锁 ────────────────────────────────────────────────────────────
// 触发首次请求(建立快照),再改 env 指死代理,观察后续 direct 请求的落点。
await statusOf(originUrl);
process.env.HTTPS_PROXY = deadUrl;

seenByProxy.length = 0;
const afterStatus = await statusOf(originUrl);
const wentToDead = afterStatus === "ERR";
const reachedOrigin = afterStatus === 204;
check("A1 快照锁仍在:运行时改 env 后 direct 请求不转投死代理(仍达真靶)", reachedOrigin && !wentToDead, { afterStatus });
check("A2 死代理确实不可达(对照组有效)", (await statusOf(deadUrl)) === "ERR");
console.log(`  ..  env 快照锁: 首次请求后改 HTTPS_PROXY=${deadUrl},direct 请求 ${reachedOrigin ? "仍达真靶(锁仍在)" : wentToDead ? "转投死代理(锁已解除!)" : "落到别处"}`);

// 清理 env,避免影响后续用例与本进程外其它逻辑。
delete process.env.HTTPS_PROXY;

// ── B. 拦截器 per-request 分流 ───────────────────────────────────────────────
// 注意:net.ts 的 bypass 把 localhost/127.0.0.1/::1 硬编码为「永远直连」,
// 故 manual 用例不能用 loopback 当靶标(会被真实代码正确绕过,误判成失败)。
// 改用非 loopback 域名 .invalid(RFC 2606 保留,永不解析):代理生效 → 请求送达
// 代理(由代理返回 200);代理被绕过 → 才轮到 DNS 解析 .invalid 并失败。
// 于是「代理有没有收到请求」即 manual 模式是否真注入了 proxy 选项的决定性信号。
const manualTarget = "http://proxy-probe.invalid/target";
seenByProxy.length = 0;
cfg = { mode: "manual", url: proxyUrl, bypassRules: "" } as ProxyConfig;
const manualStatus = await statusOf(manualTarget);
check("B1 manual 模式:请求经指定代理(代理收到 .invalid 请求并应答)", seenByProxy.length === 1 && manualStatus === 200, { manualStatus, seenByProxy: seenByProxy.length });

seenByProxy.length = 0;
cfg = directCfg;
const directStatus = await statusOf(originUrl);
check("B2 direct 模式:请求绕过在线代理直连真靶", seenByProxy.length === 0 && directStatus === 204, { directStatus, seenByProxy: seenByProxy.length });

// ── C. 错误分类正则(对 A2) ─────────────────────────────────────────────────
cfg = { mode: "manual", url: proxyUrl, bypassRules: "" } as ProxyConfig; // 有代理时分类才产出友好提示
let classified: string | null = null;
let errShape: Record<string, unknown> = {};
try {
  await fetch(deadUrl);
} catch (err) {
  errShape = {
    ctor: err instanceof Error ? err.constructor.name : typeof err,
    code: (err as { code?: unknown }).code,
    msg: err instanceof Error ? err.message : String(err),
  };
  classified = classifyProxyError(err, cfg);
}
check("C1 fetch 死端口抛错且 code/message 形态符合预期", typeof errShape.msg === "string" && errShape.msg.length > 0, errShape);
check("C2 classifyProxyError 正则命中,产出友好提示", typeof classified === "string" && classified.includes("代理连接失败"), { classified });
console.log(`  ..  错误形态: ${JSON.stringify(errShape)}`);

// ── D. 统一注入 timeout:0(禁用 Bun 300s socket 空闲定时器)────────────────────
// 拦截器对所有走 globalThis.fetch 的调用注入 timeout:0(net.ts),让应用层看门狗当唯一
// 计时源——新引擎(第三/四个 agent 引擎)的 LLM fetch 自动继承,无需各自记得加。
// timeout 不在 fetch 上暴露可观测值,故用两条间接断言锁定注入行为:
cfg = directCfg;
// D1 注入后正常请求仍成功(timeout:0 形态被 Bun 接受、未破坏请求本身)。
const injectedStatus = await statusOf(originUrl);
check("D1 注入 timeout:0 后正常请求仍达真靶(注入形态合法、无副作用)", injectedStatus === 204, { injectedStatus });
// D2 护栏:调用方显式传 timeout:false 时不被拦截器覆盖,且不报错(显式值被尊重)。
let explicitOk = false;
try {
  const r = await fetch(originUrl, { timeout: false } as RequestInit);
  explicitOk = r.status === 204;
} catch (err) {
  explicitOk = false;
}
check("D2 显式 timeout:false 被尊重(拦截器不覆盖、不报错)", explicitOk);

proxy.stop(true);
origin.stop(true);
console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
