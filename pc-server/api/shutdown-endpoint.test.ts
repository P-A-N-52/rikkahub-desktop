// 全面审查 8-2/1-1 回归测试:优雅停机端点端到端契约——POST /api/app/shutdown 必须在
// 全部状态刷盘后返回 200,随后进程以 0 码自退。Tauri 壳(Windows kill=TerminateProcess,
// 信号钩子不运行)依赖这个契约:收到 200 后硬杀是零丢失的。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dir, "..", "server.ts");

describe("POST /api/app/shutdown(优雅停机端点)", () => {
  test("返回 200 后进程以 0 码自退", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18230", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

      // 200 的契约:刷盘已完成,进程随后自退(端点内 100ms 延迟 + 退出)
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("进程 5s 内未自退")), 5000)),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      proc.kill();
    }
  }, 30_000);

  // 日志问题 2 真根因回归锁:Tauri 壳用 std::net::TcpStream 手写原始 HTTP 报文,行结束符
  // 必须是 CRLF——Rust 多行字符串字面量的换行被规范化成 bare LF,Bun 解析器直接拒收
  // (505 HTTP Version Not Supported),优雅停机静默失败、每次退出都硬杀,取证残留误报
  // "上次未正常退出"。本用例按壳侧 request_sidecar_shutdown 的精确字节流打端点,
  // 锁住"壳报文 ↔ Bun 解析器"的字节级契约(壳或 Bun 任一侧漂移都会在这里现形)。
  test("Tauri 壳的原始 CRLF 报文(字节级契约):200 且进程自退", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e4-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18260", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      // 与 web-ui/src-tauri/src/lib.rs request_sidecar_shutdown 的 format! 字符串逐字节一致。
      const rawRequest = `POST /api/app/shutdown HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
      const firstLine = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(rawRequest));
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
        });
        socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
        setTimeout(() => {
          socket.destroy();
          reject(new Error("壳报文 3s 内无响应(解析被拒?)"));
        }, 3000);
      });
      expect(firstLine).toBe("HTTP/1.1 200 OK"); // 壳侧 starts_with("HTTP/1.1 200") 的判据
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("进程 5s 内未自退")), 5000)),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      proc.kill();
    }
  }, 30_000);

  // 批次二 R5-1:本机反代(nginx/caddy)会让远程请求以 127.0.0.1 到达 Bun,裸回环判定
  // 被穿透。带任一代理转发头的请求一定不是 Tauri 壳发的——必须 403 且服务不退。
  test("带代理转发头的请求被拒绝,服务不停机", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e3-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18250", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const proxyHeaderVariants: Record<string, string>[] = [
        { "X-Forwarded-For": "203.0.113.7" },
        { "X-Real-IP": "203.0.113.7" },
        { Forwarded: "for=203.0.113.7" },
      ];
      for (const headers of proxyHeaderVariants) {
        const res = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, {
          method: "POST",
          headers,
        });
        expect(res.status).toBe(403);
      }
      // 服务仍然活着;无转发头的本机直连照常停机
      const alive = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
      expect(alive.status).toBe(200);
    } finally {
      proc.kill();
    }
  }, 30_000);

  test("GET 方法不触发停机(只接受 POST)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e2-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18240", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "GET" });
      expect(res.status).not.toBe(200);
      // 服务仍然活着
      const alive = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
      expect(alive.status).toBe(200);
    } finally {
      proc.kill();
    }
  }, 30_000);
});
