// workspace/agents-file.test.ts — P4 AGENTS.md 编辑入口(方案 §3.3)
//
// 领域不变式:读写"pi 实际加载的那个候选文件"(loadContextFileFromDir 同序),
// 无则模板引导新建 AGENTS.md;超限拒写;API 面 GET/PUT 全链路。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agentsfile-test-"));

const conversations = await import("../conversations");
conversations.openConversationsDb();
const ws = await import("../workspace");
const { DEFAULT_AGENTS_TEMPLATE, readWorkspaceAgentsFile, writeWorkspaceAgentsFile } = await import("./files");
const { handleWorkspaceRoutes } = await import("../api/handlers/workspaces");

afterAll(() => {
  // 独占 mkdtemp 数据目录,无需清理。
});

describe("AGENTS.md 领域操作", () => {
  test("无文件:exists=false 且带默认模板;写入即创建标准名 AGENTS.md", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "agents-blank" });
    const initial = readWorkspaceAgentsFile(workspace);
    expect(initial).toMatchObject({ fileName: "AGENTS.md", exists: false, content: "" });
    expect(initial.template).toBe(DEFAULT_AGENTS_TEMPLATE);

    const written = writeWorkspaceAgentsFile(workspace, "# 我的项目指引\n");
    expect(written.fileName).toBe("AGENTS.md");
    expect(readFileSync(join(workspace.root, "AGENTS.md"), "utf-8")).toBe("# 我的项目指引\n");
    expect(readWorkspaceAgentsFile(workspace)).toMatchObject({ exists: true, content: "# 我的项目指引\n" });
  });

  test("已有 CLAUDE.md:读写就地跟随 pi 的候选序,不产生被遮蔽的第二份", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "agents-claude" });
    writeFileSync(join(workspace.root, "CLAUDE.md"), "claude instructions", "utf-8");
    expect(readWorkspaceAgentsFile(workspace)).toMatchObject({ fileName: "CLAUDE.md", exists: true, content: "claude instructions" });

    writeWorkspaceAgentsFile(workspace, "updated");
    expect(readFileSync(join(workspace.root, "CLAUDE.md"), "utf-8")).toBe("updated");
  });

  test("超限拒写(512KB)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "agents-limit" });
    expect(() => writeWorkspaceAgentsFile(workspace, "x".repeat(512 * 1024 + 1))).toThrow("too large");
  });
});

describe("AGENTS.md API", () => {
  test("GET/PUT 全链路;工作区不存在 404", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "agents-api" });
    const base = `workspaces/${workspace.id}/agents-file`;
    const url = new URL(`http://localhost/api/${base}`);

    const got = await handleWorkspaceRoutes(new Request(url), url, base);
    expect(got?.status).toBe(200);
    const gotBody = (await got?.json()) as { agentsFile: { exists: boolean; template: string } };
    expect(gotBody.agentsFile.exists).toBe(false);
    expect(gotBody.agentsFile.template).toContain("# AGENTS.md");

    const put = await handleWorkspaceRoutes(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "api written" }),
      }),
      url,
      base,
    );
    expect(put?.status).toBe(200);
    expect(readFileSync(join(workspace.root, "AGENTS.md"), "utf-8")).toBe("api written");

    const missing = new URL("http://localhost/api/workspaces/nope/agents-file");
    const notFound = await handleWorkspaceRoutes(new Request(missing), missing, "workspaces/nope/agents-file");
    expect(notFound?.status).toBe(404);
  });
});
