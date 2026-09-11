// Isolated HTTP fixture. Production server.ts never imports this module.
import { createHash } from "node:crypto";
import { handleUpdateRoutes } from "../api/handlers/update";
import { serverWork } from "../foundation/lifecycle";
import { RELEASE_REPOSITORY, macInstallerName } from "../updates/releases";

const version = "9.0.0-preview.2+fixture.1";
const name = macInstallerName(version, process.arch)!;
const payload = new TextEncoder().encode("This is a local HTTP installer fixture, not a tar archive.\n");
const checksum = createHash("sha256").update(payload).digest("hex");
let mode = "complete";
let canceled = 0;
const assetServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  if (mode === "http-error") return new Response("local failure", { status: 503 });
  if (mode === "wait") return new Response(new ReadableStream({
    start(controller) { controller.enqueue(payload.slice(0, 4)); },
    cancel() { canceled++; },
  }));
  return new Response(mode === "truncated" ? payload.slice(0, 4) : payload);
} });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = String(input instanceof Request ? input.url : input);
  const base = `https://github.com/${RELEASE_REPOSITORY}`;
  if (url === `${base}/releases/latest`) return new Response(null, { status: 302, headers: { location: `${base}/releases/tag/v${version}` } });
  if (url === `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`) {
    return Response.json({ tag_name: `v${version}`, name: "HTTP fixture release", assets: mode === "missing" ? [] : [{
      name, size: payload.length, digest: `sha256:${checksum}`,
      browser_download_url: `${base}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
    }] });
  }
  if (url.startsWith(`${base}/releases/download/`)) return originalFetch(`http://127.0.0.1:${assetServer.port}/installer`, { ...init, proxy: "" });
  throw new Error("Update fixture refused an unexpected external request");
}, originalFetch);

const apiServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/startup/status") return Response.json({ ready: true });
  if (url.pathname === "/fixture/mode" && request.method === "POST") {
    mode = (await request.json() as { mode: string }).mode;
    return Response.json({ mode });
  }
  if (url.pathname === "/fixture/status") return Response.json({ canceled });
  if (url.pathname === "/fixture/stop") {
    serverWork.stop();
    await serverWork.drain(Date.now() + 2000);
    setTimeout(() => { apiServer.stop(true); assetServer.stop(true); process.exit(0); }, 30);
    return Response.json({ ok: true });
  }
  return await handleUpdateRoutes(request, url, url.pathname.replace(/^\/api\//, "")) ?? new Response(null, { status: 404 });
} });
console.log(`RIKKAHUB_PORT:${apiServer.port}`);
