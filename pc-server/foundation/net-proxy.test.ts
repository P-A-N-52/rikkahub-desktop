import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMacosProxySettings, parseProxyServerValue, redactProxyForLog } from "./net";

const dictionary = (fields: Record<string, string | number>) =>
  `<dictionary> {\n${Object.entries(fields).map(([key, value]) => `  ${key} : ${value}`).join("\n")}\n}`;

describe("macOS current system proxy settings", () => {
  test.each(["", "<dictionary> {\n}", "HTTPEnable : 1\nHTTPProxy : proxy.invalid\nHTTPPort : 8080"])(
    "missing global configuration is direct: %s", (output) => {
      expect(parseMacosProxySettings(output)).toEqual({ proxy: undefined, pac: undefined });
    },
  );

  test("prefers the HTTPS CONNECT endpoint and falls back to enabled HTTP", () => {
    const settings = { HTTPEnable: 1, HTTPProxy: "http-proxy.invalid", HTTPPort: 8080,
      HTTPSEnable: 1, HTTPSProxy: "https-proxy.invalid", HTTPSPort: 8443 };
    expect(parseMacosProxySettings(dictionary(settings)).proxy).toBe("http://https-proxy.invalid:8443");
    expect(parseMacosProxySettings(dictionary({ ...settings, HTTPSEnable: 0 })).proxy)
      .toBe("http://http-proxy.invalid:8080");
    expect(parseMacosProxySettings(dictionary({ ...settings, HTTPSPort: 0 })).proxy)
      .toBe("http://http-proxy.invalid:8080");
  });

  test.each(["::1", "[::1]", "2001:db8::7"])("accepts IPv6 proxy host %s", (host) => {
    expect(parseMacosProxySettings(dictionary({ HTTPEnable: 1, HTTPProxy: host, HTTPPort: 7897 })).proxy)
      .toBe(`http://[${host.replace(/^\[|\]$/g, "")}]:7897`);
  });

  test.each(["", "proxy.invalid:8080", "http://proxy.invalid", "socks5://proxy.invalid", "user:secret@proxy.invalid",
    "proxy.invalid/path", "proxy.invalid?query", "proxy.invalid#hash", "proxy.invalid\\path", "bad host",
    "[not-ipv6]", "[::1", "fe80::1%en0", "%70roxy.invalid", "proxy\u0000.invalid"])(
    "rejects malformed or credential-bearing host %s", (host) => {
      expect(parseMacosProxySettings(dictionary({ HTTPEnable: 1, HTTPProxy: host, HTTPPort: 7897 })).proxy)
        .toBeUndefined();
    },
  );

  test.each(["", "0", "65536", "-1", "7897.5", "7897junk", "Infinity"])("rejects invalid port %s", (port) => {
    expect(parseMacosProxySettings(dictionary({ HTTPEnable: 1, HTTPProxy: "localhost", HTTPPort: port })).proxy)
      .toBeUndefined();
  });

  test("disabled and SOCKS-only endpoints never become an HTTP proxy", () => {
    expect(parseMacosProxySettings(dictionary({ HTTPEnable: 0, HTTPProxy: "localhost", HTTPPort: 7897,
      HTTPSEnable: 0, HTTPSProxy: "localhost", HTTPSPort: 7897,
      SOCKSEnable: 1, SOCKSProxy: "localhost", SOCKSPort: 7897 })).proxy).toBeUndefined();
  });

  test("ignores scoped and supplemental dictionaries, including their PAC settings", () => {
    const nested = `<dictionary> {
      __SCOPED__ : <dictionary> {
        en0 : <dictionary> {
          HTTPEnable : 1
          HTTPProxy : scoped.invalid
          HTTPPort : 8000
          ProxyAutoConfigEnable : 1
          ProxyAutoConfigURLString : http://scoped.invalid/proxy.pac
        }
      }
      __SUPPLEMENTAL__ : <array> {
        0 : <dictionary> {
          HTTPSEnable : 1
          HTTPSProxy : supplemental.invalid
          HTTPSPort : 8001
        }
      }
      ExceptionsList : <array> {
        0 : localhost
      }
      HTTPEnable : 1
      HTTPProxy : global.invalid
      HTTPPort : 8002
    }`;
    expect(parseMacosProxySettings(nested)).toEqual({ proxy: "http://global.invalid:8002", pac: undefined });
    expect(parseMacosProxySettings(nested.replace("HTTPProxy : global.invalid", "HTTPProxy : ")).proxy)
      .toBeUndefined();
  });

  test("PAC and WPAD are enabled diagnostics only; disabled stale URLs are ignored", () => {
    const url = "http://pac.invalid/proxy.pac";
    expect(parseMacosProxySettings(dictionary({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: url })))
      .toEqual({ proxy: undefined, pac: url });
    expect(parseMacosProxySettings(dictionary({ ProxyAutoConfigEnable: 0, ProxyAutoConfigURLString: url })).pac)
      .toBeUndefined();
    expect(parseMacosProxySettings(dictionary({ ProxyAutoDiscoveryEnable: 1 })).pac).toBe("wpad");
    expect(parseMacosProxySettings(dictionary({ ProxyAutoConfigEnable: 1 })).pac).toBe("pac");
    expect(parseMacosProxySettings(dictionary({ ProxyAutoConfigEnable: 0, ProxyAutoDiscoveryEnable: 0 })).pac)
      .toBeUndefined();
  });

  test("retains the existing Windows protocol precedence and SOCKS exclusion", () => {
    expect(parseProxyServerValue("http=one.invalid:80;https=two.invalid:81;socks=three.invalid:82"))
      .toBe("http://two.invalid:81");
    expect(parseProxyServerValue("http=one.invalid:80;socks=three.invalid:82")).toBe("http://one.invalid:80");
    expect(parseProxyServerValue("socks=three.invalid:82")).toBeUndefined();
  });

  test("logs hide both credentials, including malformed URLs", () => {
    expect(redactProxyForLog("http://test-user:test-password@proxy.invalid:8080"))
      .toBe("http://***:***@proxy.invalid:8080/");
    expect(redactProxyForLog("http://test-user@proxy.invalid:8080"))
      .toBe("http://***@proxy.invalid:8080/");
    expect(redactProxyForLog("http://test-user:test-password@[bad"))
      .toBe("[invalid proxy URL]");
  });
});

// Isolate Bun's process-wide proxy environment snapshot and our cache/fetch wrapper.
// The fixture replaces scutil output; it never reads or changes the real system proxy.
async function isolated(source: string, container = false): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rikka-proxy-"));
  const modulePath = join(import.meta.dir, "net.ts");
  const path = join(dir, "fixture.ts");
  try {
    writeFileSync(path, `import assert from "node:assert/strict";
      Object.defineProperty(process, "platform", { value: "darwin" });
      const net = await import(${JSON.stringify(modulePath)});
      ${source}
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, RIKKAHUB_PC_DATA_DIR: join(dir, "data"), RIKKAHUB_CONTAINER: container ? "1" : "0" };
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy"]) delete env[key];
    const child = Bun.spawn([process.execPath, path], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`Proxy fixture failed (${code}): ${stderr}\n${stdout}`);
    } finally { clearTimeout(watchdog); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("macOS probes use scutil asynchronously and tolerate command failures", async () => {
  await isolated(`
    let output = ${JSON.stringify(dictionary({ HTTPSEnable: 1, HTTPSProxy: "::1", HTTPSPort: 7897 }))};
    let code = 0;
    const calls = [];
    Bun.spawn = (command) => {
      calls.push(command);
      return { stdout: new Response(output).body, exited: Promise.resolve(code) };
    };
    assert.equal(await net.detectSystemProxy(), "http://[::1]:7897");
    assert.deepEqual(calls, [["/usr/sbin/scutil", "--proxy"]]);
    output = ${JSON.stringify(dictionary({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "http://pac.invalid/proxy.pac" }))};
    assert.equal(await net.detectSystemProxy(), undefined);
    assert.equal(await net.detectSystemPacUrl(), "http://pac.invalid/proxy.pac");
    code = 1;
    assert.equal(await net.detectSystemPacUrl(), undefined);
    assert.equal(await net.detectSystemProxy(), undefined);
    Bun.spawn = () => { throw new Error("scutil unavailable"); };
    assert.equal(await net.detectSystemProxy(), undefined);
    assert.equal(await net.detectSystemPacUrl(), undefined);
  `);
});

test("local mock verifies auto/manual/direct, single-flight cache refresh, disable and failed endpoints", async () => {
  await isolated(`
    const servers = [];
    const serve = (body) => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
      servers.push(server); return server;
    };
    const origin = serve("origin"), first = serve("first"), second = serve("second");
    const originUrl = "http://127.0.0.1:" + origin.port;
    const firstUrl = "http://127.0.0.1:" + first.port;
    const secondUrl = "http://127.0.0.1:" + second.port;
    const target = "http://proxy-probe.invalid/resource";
    const settings = (port, enabled = 1) => "<dictionary> {\\n  HTTPSEnable : " + enabled
      + "\\n  HTTPSProxy : 127.0.0.1\\n  HTTPSPort : " + port + "\\n}";
    let output = settings(first.port), calls = 0, release;
    let gate = Promise.resolve();
    Bun.spawn = (command) => {
      assert.deepEqual(command, ["/usr/sbin/scutil", "--proxy"]);
      calls++;
      const text = output, wait = gate;
      return { stdout: new ReadableStream({ async start(controller) {
        await wait; controller.enqueue(new TextEncoder().encode(text)); controller.close();
      } }), exited: Promise.resolve(0) };
    };
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    let cfg = { mode: "auto", bypassRules: "" };
    net.installProxyFetchInterceptor(() => cfg);
    const body = async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).text();
    try {
      // Cold reads return immediately; startup preheat joins the same pending operation.
      assert.equal(net.readSystemProxy(), undefined);
      const prime = net.primeSystemProxyCache();
      assert.equal(net.primeSystemProxyCache(), prime);
      await prime;
      assert.equal(calls, 1);
      assert.equal(await body(target), "first");
      assert.equal(net.resolveEffectiveProxy(cfg).source, "system");
      assert.equal(calls, 1);

      output = settings(second.port);
      gate = new Promise(resolve => { release = resolve; });
      clock += net.SYSTEM_PROXY_TTL_MS;
      assert.equal(net.readSystemProxy(), firstUrl);
      assert.equal(net.readSystemProxy(), firstUrl);
      assert.equal(calls, 2);
      assert.equal(await body(target), "first");
      const refresh = net.primeSystemProxyCache();
      release(); await refresh; gate = Promise.resolve();
      assert.equal(calls, 2);
      assert.equal(await body(target), "second");

      cfg = { mode: "manual", url: firstUrl, username: "test-user", password: "test-password", bypassRules: "" };
      assert.equal(await body(target), "first");
      assert.equal(net.resolveEffectiveProxy(cfg).source, "manual");
      assert.equal(net.proxyStatusPayload(cfg).activeUrl, firstUrl);
      assert.equal(await body(originUrl), "origin"); // loopback bypass remains unconditional
      cfg = { mode: "direct" };
      assert.deepEqual(net.resolveEffectiveProxy(cfg), { url: undefined, source: "none" });
      assert.equal(await body(originUrl), "origin");
      assert.equal(calls, 2);

      cfg = { mode: "auto", bypassRules: "" };
      output = settings(second.port, 0); await net.primeSystemProxyCache();
      assert.deepEqual(net.resolveEffectiveProxy(cfg), { url: undefined, source: "none" });
      assert.equal(await body(originUrl), "origin");

      const dead = serve("unused"), deadPort = dead.port; dead.stop(true);
      output = settings(deadPort); await net.primeSystemProxyCache();
      await assert.rejects(() => body(target), error => {
        assert.match(net.classifyProxyError(error, cfg), /代理连接失败/); return true;
      });
      output = settings(second.port); await net.primeSystemProxyCache();
      assert.equal(await body(target), "second");
    } finally { Date.now = realNow; for (const server of servers) server.stop(true); }
  `);
});

test("local mock verifies env mode leaves the container runtime's environment proxy in charge", async () => {
  await isolated(`
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("env-proxy") });
    const url = "http://127.0.0.1:" + proxy.port;
    process.env.HTTP_PROXY = url; process.env.HTTPS_PROXY = url;
    Bun.spawn = () => { throw new Error("env mode must not probe the system"); };
    const cfg = { mode: "env" };
    net.installProxyFetchInterceptor(() => cfg);
    try {
      assert.equal(process.env.HTTPS_PROXY, url);
      assert.deepEqual(net.resolveEffectiveProxy(cfg), { url, source: "env" });
      const result = await fetch("http://proxy-probe.invalid/env", { signal: AbortSignal.timeout(2000) });
      assert.equal(await result.text(), "env-proxy");
    } finally { proxy.stop(true); }
  `, true);
});
