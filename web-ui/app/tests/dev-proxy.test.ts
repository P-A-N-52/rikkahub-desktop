import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createViteServer, type ProxyOptions, type ViteDevServer } from "vite";
import config from "../../vite.config";

describe("desktop development SSE proxy", () => {
  const responses = new Map<string, ServerResponse>();
  const backend = createHttpServer((request, response) => {
    responses.set(request.url!, response);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  let vite: ViteDevServer;
  let origin: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const backendPort = (backend.address() as { port: number }).port;
    const actualProxy = config.server!.proxy!["/api"] as ProxyOptions;
    vite = await createViteServer({
      configFile: false,
      envFile: false,
      plugins: [],
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: "127.0.0.1", port: 0, strictPort: true, watch: null, hmr: false,
        proxy: { "/api": { ...actualProxy, target: `http://127.0.0.1:${backendPort}` } },
      },
    });
    await vite.listen();
    origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await vite?.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  test("forwards the first event before a normal stream ends", async () => {
    const response = await fetch(`${origin}/api/complete`, { signal: AbortSignal.timeout(3_000) });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    const upstream = responses.get("/api/complete")!;
    expect(upstream.writableEnded).toBe(false);
    upstream.end("data: last\n\n");
    let text = new TextDecoder().decode(first.value);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    expect(text).toBe("data: first\n\ndata: last\n\n");
  });

  test("closes the client promptly when an active upstream stream breaks", async () => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetch(`${origin}/api/interrupted`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      });
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const disconnected = reader.read().then((chunk) => chunk.done, () => true);
      responses.get("/api/interrupted")!.socket!.destroy();
      const promptlyClosed = await Promise.race([
        disconnected,
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 1_000); }),
      ]);
      expect(promptlyClosed).toBe(true);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
});
