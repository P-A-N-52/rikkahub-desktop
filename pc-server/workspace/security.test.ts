// workspace/security.test.ts — M4-1 安全审计:用真实攻击用例贯穿"边界断言 + 领域操作 + HTTP 路由"。
// 单元层(boundary/approval/files.test.ts)已覆盖 ../、盘符兄弟目录、NUL、限额、危险命令清单;
// 本文件补齐两条真正端到端的攻击向量:
//   1) 真实软链/junction 逃逸——在区内放一个指向区外的链接,realpath 必须把它揪出区外;
//   2) 文件面板 HTTP 路由的路径穿越——URLSearchParams 会自动解码,%2e%2e 等变体到 join 后
//      必须被边界拒(400),且 reveal 在 spawn 前就被拦(不给任意路径起子进程)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-sec-test-"));

const conversations = await import("../conversations");
const ws = await import("./index");
const files = await import("./files");
const { assertInsideWorkspace, WorkspaceBoundaryError } = await import("./boundary");
const { handleWorkspaceRoutes } = await import("../api/handlers/workspaces");

conversations.openConversationsDb();

let workspace: Awaited<ReturnType<typeof ws.createWorkspace>>;
let outsideDir: string;

beforeAll(() => {
  workspace = ws.createWorkspace({ type: "managed", name: "sec" });
  outsideDir = mkdtempSync(join(tmpdir(), "rkh-sec-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), "TOPSECRET");
  mkdirSync(join(outsideDir, "sub"), { recursive: true });
  writeFileSync(join(workspace.root, "inside.txt"), "hello");
});

// —— 攻击 1:软链/junction 逃逸 ——————————————————————————————————————
describe("软链逃逸(realpath 揪出区外目标)", () => {
  test("区内文件软链指向区外机密 → 读/预览/删除全被拒", async () => {
    const linkPath = join(workspace.root, "link.txt");
    let created = true;
    // Windows 文件软链需要权限(开发者模式/管理员),拿不到就跳过——Linux 上必测(M4-3)。
    try {
      symlinkSync(join(outsideDir, "secret.txt"), linkPath, "file");
    } catch {
      created = false;
    }
    if (!created) return;

    expect(() => assertInsideWorkspace(linkPath, workspace.root)).toThrow(WorkspaceBoundaryError);
    await expect(files.previewWorkspaceFile(workspace, "link.txt")).rejects.toThrow();
    expect(() => files.deleteWorkspaceEntry(workspace, "link.txt")).toThrow();
  });

  test("区内目录 junction 指向区外目录 → 列目录/穿透写入被拒", () => {
    const junctionPath = join(workspace.root, "linkdir");
    let created = true;
    // junction 在 Windows 无需管理员即可建;POSIX 上 type 参数被忽略,退化为普通目录软链。
    try {
      symlinkSync(outsideDir, junctionPath, "junction");
    } catch {
      created = false;
    }
    if (!created) return;

    expect(() => files.listWorkspaceDir(workspace, "linkdir")).toThrow(WorkspaceBoundaryError);
    // 穿透写:区内看似 linkdir/evil.txt,realpath 落到区外目录 → 拒绝
    expect(() => assertInsideWorkspace(join(workspace.root, "linkdir", "evil.txt"), workspace.root)).toThrow(
      WorkspaceBoundaryError,
    );
  });
});

// —— 攻击 2:文件面板 HTTP 路由路径穿越 ——————————————————————————————
describe("文件面板 HTTP 路由路径穿越", () => {
  function call(method: string, sub: string, opts: { query?: string; body?: unknown } = {}): Promise<Response | null> {
    const base = `http://127.0.0.1/api/workspaces/${workspace.id}/${sub}`;
    const url = new URL(opts.query ? `${base}?${opts.query}` : base);
    const path = `workspaces/${workspace.id}/${sub}`;
    const init: RequestInit = { method };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers = { "content-type": "application/json" };
    }
    return handleWorkspaceRoutes(new Request(url, init), url, path);
  }

  test("合法路径正常(阳性对照):列目录见 inside.txt、预览取回文本", async () => {
    const list = await call("GET", "files");
    expect(list?.status).toBe(200);
    const listed = (await list!.json()) as { entries: Array<{ name: string }> };
    expect(listed.entries.some((e) => e.name === "inside.txt")).toBe(true);

    const preview = await call("GET", "files/content", { query: "path=inside.txt" });
    expect(preview?.status).toBe(200);
    const body = (await preview!.json()) as { preview: { kind: string; text?: string } };
    expect(body.preview.kind).toBe("text");
    expect(body.preview.text).toBe("hello");
  });

  test("原始 ../ 穿越列目录 → 400", async () => {
    const res = await call("GET", "files", { query: "path=../../../../../../etc" });
    expect(res?.status).toBe(400);
  });

  test("URL 编码 %2e%2e 穿越预览 → 400(URLSearchParams 会解码,边界仍拦)", async () => {
    const res = await call("GET", "files/content", { query: "path=%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd" });
    expect(res?.status).toBe(400);
  });

  test("DELETE 指向父目录(..) → 400,不触达区外删除", async () => {
    const res = await call("DELETE", "files", { query: "path=.." });
    expect(res?.status).toBe(400);
  });

  test("reveal 越界路径 → 400,在 spawn 之前被边界拦下", async () => {
    const res = await call("POST", "files/reveal", { body: { path: "../../secret.txt" } });
    expect(res?.status).toBe(400);
  });

  test("rename 新名带路径分隔符/越界 → 400", async () => {
    const res = await call("POST", "files/rename", { body: { path: "inside.txt", newName: "../escaped.txt" } });
    expect(res?.status).toBe(400);
  });
});
