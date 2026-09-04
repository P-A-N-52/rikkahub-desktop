// api/export-to-path.test.ts — data/export/to-path 端点的安全闸与入参校验(问题5,2.0.0 内测)。
// 只测闸门与校验矩阵:zip 产出本体由 backup/ 套件覆盖,端点内只是 createSettingsBackupZipToPath
// 的薄胶水。回环标记语义(代理头拒绝/回环地址集)在此一并验证(net-context 单源)。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDataRoutes } from "./handlers/data";
import { isLoopbackAddress, isLoopbackRequest, markRequestNetworkContext } from "./net-context";

const url = new URL("http://127.0.0.1:8710/api/data/export/to-path");

function makeRequest(targetPath: unknown, headers?: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ targetPath }),
  });
}

async function callEndpoint(request: Request): Promise<Response> {
  const response = await handleDataRoutes(request, url, "data/export/to-path");
  if (!response) throw new Error("端点未命中路由");
  return response;
}

describe("net-context:回环判定单源", () => {
  test("isLoopbackAddress:v4/v6/映射形式命中,其余拒绝", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });

  test("标记:回环地址且无代理转发头才算本机;带转发头的回环(本机反代)不算", () => {
    const direct = makeRequest("x");
    markRequestNetworkContext(direct, "127.0.0.1");
    expect(isLoopbackRequest(direct)).toBe(true);

    const viaProxy = makeRequest("x", { "x-forwarded-for": "203.0.113.9" });
    markRequestNetworkContext(viaProxy, "127.0.0.1");
    expect(isLoopbackRequest(viaProxy)).toBe(false);

    const remote = makeRequest("x");
    markRequestNetworkContext(remote, "192.168.1.5");
    expect(isLoopbackRequest(remote)).toBe(false);
  });
});

describe("data/export/to-path:闸门与校验矩阵", () => {
  test("未标记回环(局域网/未经 serve 标记)→ 403", async () => {
    const res = await callEndpoint(makeRequest(join(tmpdir(), "b.zip")));
    expect(res.status).toBe(403);
  });

  async function loopbackCall(targetPath: unknown): Promise<Response> {
    const req = makeRequest(targetPath);
    markRequestNetworkContext(req, "127.0.0.1");
    return callEndpoint(req);
  }

  test("相对路径/非 zip 后缀/非字符串 → 400", async () => {
    expect((await loopbackCall("relative/b.zip")).status).toBe(400);
    expect((await loopbackCall(join(tmpdir(), "b.tar.gz"))).status).toBe(400);
    expect((await loopbackCall(42)).status).toBe(400);
  });

  test("Windows 保留设备名 → 400;目标目录不存在 → 400", async () => {
    expect((await loopbackCall(join(tmpdir(), "nul.zip"))).status).toBe(400);
    expect((await loopbackCall(join(tmpdir(), "no-such-dir-9f2c", "b.zip"))).status).toBe(400);
  });
});
