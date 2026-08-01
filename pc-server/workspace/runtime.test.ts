// workspace/runtime.test.ts — 工作区运行时集成测试(M1-4)
// 覆盖:条件挂载(非工作区/不可用/未信任)、执行守卫链(解绑会话/危险命令/知情同意放行)、
// pi 内核全链路(write→read→edit 经有界 Operations)、审批矩阵经 tools/approval 联动、
// 提示词段(结构锚点 + AGENTS.md 冻结快照)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-runtime-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("./index");
const runtime = await import("./runtime");
const prompt = await import("./prompt");
const approval = await import("../tools/approval");

const db = conversations.openConversationsDb();
// working set 注入是模块级全局,会被其他测试文件覆盖(如 continuation-delete-guard 的 beforeAll
// 把 loadConversation 打成 () => undefined)。在本文件 beforeAll 重注入:bun 各测试文件顺序执行,
// beforeAll 恰在本文件用例前生效,保证 getConversation 走真实 DB。
function installWorkingSet() {
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = conversations.loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
}
installWorkingSet();
beforeAll(installWorkingSet);

let seq = 0;
function bindConversation(workspaceId: string | null, workspaceCwd: string | null = null) {
  seq += 1;
  const conversation = {
    id: `conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId,
    workspaceCwd,
  };
  conversations.persistConversation(conversation);
  return conversation;
}

const fakeAssistant = { id: "a1", name: "A", systemPrompt: "", mcpServers: [] } as never;

describe("条件挂载(openAiWorkspaceTools)", () => {
  test("非工作区会话不挂载", () => {
    expect(runtime.openAiWorkspaceTools(null)).toEqual([]);
    expect(runtime.openAiWorkspaceTools(bindConversation(null))).toEqual([]);
  });

  test("managed 工作区挂载 pi 工具(schema 锚点)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "m1" });
    const tools = runtime.openAiWorkspaceTools(bindConversation(workspace.id));
    const names = tools.map((t) => (t.function as { name: string }).name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    // bash 随 shell 探针(本机无 bash 则不挂载,双端一致性由探针保证)
    if (runtime.shellAvailability().available) expect(names).toContain("bash");
    const read = tools.find((t) => (t.function as { name: string }).name === "read")!.function as Record<string, unknown>;
    expect(String(read.description)).toContain("Read the contents of a file");
    expect((read.parameters as { required: string[] }).required).toEqual(["path"]);
  });

  test("folder 工作区未过信任门不挂载;信任后挂载", () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-folder-"));
    const workspace = ws.createWorkspace({ type: "folder", root });
    const conversation = bindConversation(workspace.id);
    expect(runtime.openAiWorkspaceTools(conversation)).toEqual([]);
    ws.trustWorkspace(workspace.id);
    expect(runtime.openAiWorkspaceTools(conversation).length).toBeGreaterThan(0);
  });
});

describe("执行守卫链(runWorkspaceTool)", () => {
  test("非工作区会话的残留调用被拒", async () => {
    const conversation = bindConversation(null);
    await expect(
      runtime.runWorkspaceTool("read", { path: "a.txt" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/not bound to a workspace/);
  });

  test("工作区已删除被拒", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gone" });
    const conversation = bindConversation(workspace.id);
    // 直接删 DB 记录(deleteWorkspace 会顺带解绑会话,这里模拟悬挂引用)
    db.exec(`DELETE FROM pc_workspace WHERE id = '${workspace.id}'`);
    await expect(
      runtime.runWorkspaceTool("read", { path: "a.txt" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/no longer exists/);
  });

  test("危险命令未经批准被拦;userApproved 放行到 shell 层", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "danger" });
    const conversation = bindConversation(workspace.id);
    await expect(
      runtime.runWorkspaceTool("bash", { command: "rm -rf /" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/blocked by safety policy/);
    if (runtime.shellAvailability().available) {
      // 知情同意放行:不真跑 rm,用同样命中清单的无害变体验证闸门本身
      const result = await runtime.runWorkspaceTool(
        "bash",
        { command: "echo would-run; true # rm -rf /" },
        { conversationId: conversation.id, userApproved: true },
      );
      const text = result.output.map((o) => ("text" in o ? o.text : "")).join("");
      expect(text).toContain("would-run");
    }
  });
});

describe("pi 内核全链路(有界 Operations)", () => {
  const workspace = ws.createWorkspace({ type: "managed", name: "e2e" });
  const conversation = bindConversation(workspace.id);
  const ctx = { conversationId: conversation.id };

  test("write → read → edit 闭环,details 挂 metadata.workspace", async () => {
    const written = await runtime.runWorkspaceTool("write", { path: "src/app.ts", content: "const a = 1;\n" }, ctx);
    expect(written.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("Successfully wrote");

    const read = await runtime.runWorkspaceTool("read", { path: "src/app.ts" }, ctx);
    expect(read.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("const a = 1;");

    const edited = await runtime.runWorkspaceTool(
      "edit",
      { path: "src/app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      ctx,
    );
    const first = edited.output[0] as { metadata?: { workspace?: { tool: string; details: { diff?: string } } } };
    expect(first.metadata?.workspace?.tool).toBe("edit");
    expect(String(first.metadata?.workspace?.details.diff ?? "")).toContain("const a = 2;");
  });

  test("越界路径被有界 Operations 拒绝", async () => {
    await expect(runtime.runWorkspaceTool("read", { path: "../../etc/passwd" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(
      runtime.runWorkspaceTool("write", { path: "../escape.txt", content: "x" }, ctx),
    ).rejects.toThrow(/outside the workspace/);
  });

  test("workspaceCwd 生效:相对路径以 cwd 解析", async () => {
    await runtime.runWorkspaceTool("write", { path: "sub/inner.txt", content: "inner\n" }, ctx);
    const scoped = bindConversation(workspace.id, join(workspace.root, "sub"));
    const read = await runtime.runWorkspaceTool("read", { path: "inner.txt" }, { conversationId: scoped.id });
    expect(read.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("inner");
  });
});

describe("审批矩阵经 tools/approval 联动", () => {
  test("balanced:write 免审、bash 审批;confirm_each:write 审批;full_access 全免", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "appr" }); // 默认 balanced
    const conversation = bindConversation(workspace.id);
    expect(approval.toolNeedsApproval("write", fakeAssistant, conversation)).toBe(false);
    expect(approval.toolNeedsApproval("bash", fakeAssistant, conversation)).toBe(true);
    expect(approval.toolNeedsApproval("read", fakeAssistant, conversation)).toBe(false);

    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    expect(approval.toolNeedsApproval("write", fakeAssistant, conversation)).toBe(true);
    expect(approval.initialApprovalState("edit", fakeAssistant, conversation)).toEqual({ type: "pending" });

    ws.updateWorkspace(workspace.id, { permissionPreset: "full_access" });
    expect(approval.toolNeedsApproval("bash", fakeAssistant, conversation)).toBe(false);
  });

  test("非工作区会话对同名工具不挂审批(执行层守卫兜底)", () => {
    expect(approval.toolNeedsApproval("bash", fakeAssistant, bindConversation(null))).toBe(false);
    expect(approval.toolNeedsApproval("bash", fakeAssistant, undefined)).toBe(false);
  });
});

describe("shell runner 硬化(M1-5)", () => {
  test("timeout 夹取:缺省/超限 → 30min 硬上限;合法值透传", () => {
    expect(runtime.clampBashTimeoutSeconds(undefined)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(999_999)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(60)).toBe(60);
    expect(runtime.clampBashTimeoutSeconds(-5)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(Number.NaN)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
  });

  const shellOk = runtime.shellAvailability().available;

  test.if(shellOk)("执行中部分输出经 onToolPartialOutput 回写", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "stream" });
    const conversation = bindConversation(workspace.id);
    const partials: string[] = [];
    const result = await runtime.runWorkspaceTool(
      "bash",
      { command: "echo first; sleep 0.3; echo second" },
      {
        conversationId: conversation.id,
        onToolPartialOutput: (output) => partials.push(output.map((o) => ("text" in o ? o.text : "")).join("")),
      },
    );
    const finalText = result.output.map((o) => ("text" in o ? o.text : "")).join("");
    expect(finalText).toContain("first");
    expect(finalText).toContain("second");
    // pi 内核 100ms 节流下至少应有一次仅含 first 的中间帧
    expect(partials.some((text) => text.includes("first") && !text.includes("second"))).toBe(true);
  }, 15_000);

  test.if(shellOk)("abort 杀进程树:长命令即时终止且报 Command aborted", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "abort" });
    const conversation = bindConversation(workspace.id);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runtime.runWorkspaceTool(
      "bash",
      { command: "sleep 30" },
      { conversationId: conversation.id, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/Command aborted/);
    expect(Date.now() - started).toBeLessThan(10_000); // 没等满 30s = 进程树被杀
  }, 15_000);

  test.if(shellOk)("超时终止:timeout 生效并报 timed out", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "timeout" });
    const conversation = bindConversation(workspace.id);
    await expect(
      runtime.runWorkspaceTool("bash", { command: "sleep 30", timeout: 1 }, { conversationId: conversation.id }),
    ).rejects.toThrow(/timed out after 1 seconds/);
  }, 15_000);
});

describe("提示词段(buildWorkspacePromptSegment)", () => {
  test("非工作区会话为空串;工作区会话含 pi 结构锚点", () => {
    expect(prompt.buildWorkspacePromptSegment(bindConversation(null) as never)).toBe("");
    const workspace = ws.createWorkspace({ type: "managed", name: "prompt" });
    const conversation = bindConversation(workspace.id);
    const segment = prompt.buildWorkspacePromptSegment(conversation as never);
    expect(segment).toContain("Available tools:");
    expect(segment).toContain("- read: Read file contents");
    expect(segment).toContain("Guidelines:");
    expect(segment).toContain("Use write only for new files or complete rewrites.");
    expect(segment).toContain(`Current working directory: ${workspace.root.replace(/\\/g, "/")}`);
    expect(segment).not.toContain("<project_context>"); // 无 AGENTS.md
  });

  test("AGENTS.md 注入 <project_context> 且会话级冻结(中途修改不重读)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "agents" });
    writeFileSync(join(workspace.root, "AGENTS.md"), "Always use tabs.");
    const conversation = bindConversation(workspace.id);
    const first = prompt.buildWorkspacePromptSegment(conversation as never);
    expect(first).toContain('<project_instructions path="AGENTS.md">');
    expect(first).toContain("Always use tabs.");

    writeFileSync(join(workspace.root, "AGENTS.md"), "CHANGED MID-CONVERSATION");
    const second = prompt.buildWorkspacePromptSegment(conversation as never);
    expect(second).toBe(first); // 冻结:逐字节不变(§9.2 缓存纪律)

    prompt.invalidateWorkspacePromptSnapshots();
    const third = prompt.buildWorkspacePromptSegment(conversation as never);
    expect(third).toContain("CHANGED MID-CONVERSATION");
  });
});
