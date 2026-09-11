import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForServerReady } from "../test-utils/e2e-server";

const serverEntry = join(import.meta.dir, "..", "server.ts");
const bashEntry = join(import.meta.dir, "..", "workspace/tools/bash.ts");

function isolatedData(): string {
  const dir = mkdtempSync(join(tmpdir(), "rkh-lifecycle-"));
  // No metadata or analytics network requests are needed by lifecycle tests.
  writeFileSync(join(dir, "models-dev-cache.json"), "{}");
  return dir;
}

function spawnServer(dir: string, entry = serverEntry, env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, entry, "--port", "18280", "--no-open"], {
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dir, RIKKAHUB_ANALYTICS: "0", ...env },
    stdout: "pipe", stderr: "pipe",
  });
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Lifecycle condition did not become true");
    await Bun.sleep(20);
  }
}

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw err;
  }
}

async function exited(proc: ReturnType<typeof spawnServer>): Promise<number> {
  return await Promise.race([
    proc.exited,
    Bun.sleep(10_000).then(() => { throw new Error("Server did not exit within 10 seconds"); }),
  ]);
}

function assertClean(dir: string): void {
  expect(existsSync(join(dir, "pc-server.lock"))).toBe(false);
  expect(readdirSync(join(dir, "logs")).some((name) => name.startsWith("server.boot.pending"))).toBe(false);
}

describe.skipIf(process.platform !== "darwin")("macOS server lifecycle", () => {
  for (const desktop of [true, false]) {
    test(`parent loss ${desktop ? "stops its desktop sidecar and children" : "leaves an independent server running"}`, async () => {
      const dir = isolatedData();
      const childEntry = join(dir, "child.ts");
      const parentEntry = join(dir, "parent.ts");
      const pidPath = join(dir, "children.txt");
      const sidecarPidPath = join(dir, "sidecar.txt");
      const command = 'sleep 120 & echo "$$ $!" > "$RIKKA_TEST_PIDS"; wait';
      writeFileSync(childEntry, `await import(${JSON.stringify(serverEntry)});\nconst {createLocalBashOperations}=await import(${JSON.stringify(bashEntry)});\nvoid createLocalBashOperations().exec(${JSON.stringify(command)}, ${JSON.stringify(dir)}, {onData(){}});\n`);
      writeFileSync(parentEntry, `const env={...process.env,RIKKA_TEST_PIDS:${JSON.stringify(pidPath)}};\n${desktop ? 'env.RIKKAHUB_PARENT_PID=String(process.pid);' : 'delete env.RIKKAHUB_PARENT_PID;'}\nconst child=Bun.spawn([process.execPath,${JSON.stringify(childEntry)},"--port","18290","--no-open"],{env,stdout:"inherit",stderr:"inherit"});\nawait Bun.write(${JSON.stringify(sidecarPidPath)},String(child.pid));\nsetInterval(()=>{},1000);\n`);
      const parent = spawnServer(dir, parentEntry);
      let sidecarPid = 0;
      let pids: number[] = [];
      try {
        const port = await waitForServerReady(parent);
        await until(() => existsSync(pidPath) && existsSync(sidecarPidPath));
        sidecarPid = Number(readFileSync(sidecarPidPath, "utf8"));
        pids = readFileSync(pidPath, "utf8").trim().split(/\s+/).map(Number);
        parent.kill("SIGKILL");
        await parent.exited;
        if (desktop) {
          await until(() => gone(sidecarPid), 10_000);
        } else {
          await Bun.sleep(500);
          expect(gone(sidecarPid)).toBe(false);
          expect((await fetch(`http://127.0.0.1:${port}/api/settings`)).status).toBe(200);
          expect((await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" })).status).toBe(200);
          await until(() => gone(sidecarPid));
        }
        for (const pid of pids) expect(gone(pid)).toBe(true);
        assertClean(dir);
      } finally {
        parent.kill("SIGKILL");
        for (const pid of [sidecarPid, ...pids]) { if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} } }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a mismatched desktop PID fails before acquiring the data lock", async () => {
    const dir = isolatedData();
    const proc = spawnServer(dir, serverEntry, { RIKKAHUB_PARENT_PID: String(process.pid + 1_000_000) });
    try {
      expect(await exited(proc)).toBe(1);
      expect(await new Response(proc.stdout).text()).toContain("does not match the actual parent");
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(false);
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("state write failure returns 500, preserves evidence and can recover on restart", async () => {
    const dir = isolatedData();
    let proc = spawnServer(dir);
    try {
      const port = await waitForServerReady(proc);
      await until(() => existsSync(join(dir, "state.json")));
      renameSync(join(dir, "state.json"), join(dir, "state.saved.json"));
      mkdirSync(join(dir, "state.json"));
      expect((await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" })).status).toBe(500);
      expect(await exited(proc)).toBe(1);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(true);
      const pending = readdirSync(join(dir, "logs")).find((name) => name.startsWith("server.boot.pending"));
      expect(pending).toBeDefined();
      expect(readFileSync(join(dir, "logs", pending!), "utf8")).toContain("shutdownFailed");
      rmSync(join(dir, "state.json"), { recursive: true });
      renameSync(join(dir, "state.saved.json"), join(dir, "state.json"));
      proc = spawnServer(dir);
      const restoredPort = await waitForServerReady(proc);
      expect(readFileSync(join(dir, "logs/server.log"), "utf8")).toContain("shutdownFailed");
      expect((await fetch(`http://127.0.0.1:${restoredPort}/api/app/shutdown`, { method: "POST" })).status).toBe(200);
      expect(await exited(proc)).toBe(0);
      assertClean(dir);
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("SQLite dirty-write failure cannot return a successful shutdown acknowledgement", async () => {
    const dir = isolatedData();
    const fixture = join(dir, "entry.ts");
    const ready = join(dir, "readonly-ready");
    const moduleAt = (name: string) => JSON.stringify(join(import.meta.dir, "..", name));
    writeFileSync(fixture, `await import(${JSON.stringify(serverEntry)});\nconst {isStartupReady}=await import(${moduleAt("foundation/startup-gate.ts")});\nwhile(!isStartupReady()) await Bun.sleep(10);\nconst {ensureConversation}=await import(${moduleAt("conversations/helpers.ts")});\nconst {getConversationsDb,markConversationRowDirty}=await import(${moduleAt("conversations/index.ts")});\nconst conversation=ensureConversation("readonly-fixture");\nconversation.title="unsaved synthetic title";\nmarkConversationRowDirty(conversation.id);\ngetConversationsDb().exec("PRAGMA query_only=ON");\nawait Bun.write(${JSON.stringify(ready)},"ready");\n`);
    const proc = spawnServer(dir, fixture);
    try {
      const port = await waitForServerReady(proc);
      await until(() => existsSync(ready));
      expect((await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" })).status).toBe(500);
      expect(await exited(proc)).toBe(1);
      expect(existsSync(join(dir, "state.json"))).toBe(true);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(true);
      const pending = readdirSync(join(dir, "logs")).find((name) => name.startsWith("server.boot.pending"));
      expect(readFileSync(join(dir, "logs", pending!), "utf8")).toContain("state flush");
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const mode of ["http", "SIGTERM", "SIGINT", "SIGHUP", "leader-exited"] as const) {
    test(`${mode} reaps a real workspace shell process group`, async () => {
      const dir = isolatedData();
      const fixture = join(dir, "entry.ts");
      const pidPath = join(dir, "children.txt");
      const command = mode === "leader-exited"
        ? 'sleep 120 >/dev/null 2>&1 & echo "$$ $!" > "$RIKKA_TEST_PIDS"'
        : 'sleep 120 & echo "$$ $!" > "$RIKKA_TEST_PIDS"; wait';
      writeFileSync(fixture, `await import(${JSON.stringify(serverEntry)});\nconst {createLocalBashOperations}=await import(${JSON.stringify(bashEntry)});\nvoid createLocalBashOperations().exec(${JSON.stringify(command)}, ${JSON.stringify(dir)}, {onData(){}});\n`);
      const proc = spawnServer(dir, fixture, { RIKKA_TEST_PIDS: pidPath });
      let pids: number[] = [];
      try {
        const port = await waitForServerReady(proc);
        await until(() => existsSync(pidPath));
        pids = readFileSync(pidPath, "utf8").trim().split(/\s+/).map(Number);
        if (mode === "leader-exited") await until(() => gone(pids[0]!));
        expect(gone(pids[1]!)).toBe(false);
        if (mode === "SIGTERM" || mode === "SIGINT" || mode === "SIGHUP") proc.kill(mode);
        else {
          const response = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
          expect(response.status).toBe(200);
        }
        expect(await exited(proc)).toBe(0);
        for (const pid of pids) expect(gone(pid)).toBe(true);
        assertClean(dir);
      } finally {
        proc.kill("SIGKILL");
        for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("HTTP plus repeated signals shares cleanup and closes admission immediately", async () => {
    const dir = isolatedData();
    const fixture = join(dir, "entry.ts");
    const lifecycleEntry = join(import.meta.dir, "..", "foundation/lifecycle.ts");
    writeFileSync(fixture, `await import(${JSON.stringify(serverEntry)});\nconst {serverWork}=await import(${JSON.stringify(lifecycleEntry)});\nvoid serverWork.run(async()=>{await new Promise(resolve=>serverWork.signal.addEventListener("abort",resolve,{once:true}));await Bun.sleep(300);});\n`);
    const proc = spawnServer(dir, fixture);
    try {
      const port = await waitForServerReady(proc);
      const url = `http://127.0.0.1:${port}`;
      const first = fetch(`${url}/api/app/shutdown`, { method: "POST" });
      await until(async () => (await fetch(`${url}/api/settings`)).status === 503);
      proc.kill("SIGTERM");
      proc.kill("SIGINT");
      const second = fetch(`${url}/api/app/shutdown`, { method: "POST" });
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(await exited(proc)).toBe(0);
      assertClean(dir);
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("uncooperative work times out, returns failure and leaves recovery evidence", async () => {
    const dir = isolatedData();
    const fixture = join(dir, "entry.ts");
    const lifecycleEntry = join(import.meta.dir, "..", "foundation/lifecycle.ts");
    writeFileSync(fixture, `await import(${JSON.stringify(serverEntry)});\nconst {serverWork}=await import(${JSON.stringify(lifecycleEntry)});\nvoid serverWork.run(()=>new Promise(()=>{}));\n`);
    const proc = spawnServer(dir, fixture);
    try {
      const port = await waitForServerReady(proc);
      const started = Date.now();
      expect((await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" })).status).toBe(500);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(await exited(proc)).toBe(1);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(true);
      const pending = readdirSync(join(dir, "logs")).find((name) => name.startsWith("server.boot.pending"));
      expect(readFileSync(join(dir, "logs", pending!), "utf8")).toContain("active work");
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("SIGKILL preserves crash evidence and previously committed SQLite data recovers", async () => {
    const dir = isolatedData();
    let proc = spawnServer(dir);
    try {
      const port = await waitForServerReady(proc);
      const path = "/api/conversations/kill-recovery/system-prompt";
      expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ systemPrompt: "Committed before SIGKILL" }) })).status).toBe(200);
      proc.kill("SIGKILL");
      expect(await exited(proc)).not.toBe(0);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(true);
      expect(readdirSync(join(dir, "logs")).some((name) => name.startsWith("server.boot.pending"))).toBe(true);
      proc = spawnServer(dir);
      const restartedPort = await waitForServerReady(proc);
      const conversation = await (await fetch(`http://127.0.0.1:${restartedPort}/api/conversations/kill-recovery`)).json() as any;
      expect(conversation.systemPrompt).toBe("Committed before SIGKILL");
      const db = new Database(join(dir, "rikka_hub.db"), { readonly: true });
      try { expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { db.close(); }
      expect((await fetch(`http://127.0.0.1:${restartedPort}/api/app/shutdown`, { method: "POST" })).status).toBe(200);
      expect(await exited(proc)).toBe(0);
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("shutdown waits for a finite SSE producer after its Response was returned", async () => {
    const dir = isolatedData();
    const fixture = join(dir, "entry.ts");
    const startedPath = join(dir, "provider-started");
    // A deterministic local provider stub ignores abort while doing short local work.
    // This exercises a producer's lifetime independently of fetch cancellation.
    writeFileSync(fixture, `const originalFetch=globalThis.fetch;\nglobalThis.fetch=Object.assign(async(input,init)=>{\nconst url=String(input instanceof Request?input.url:input);\nif(!url.startsWith("http://127.0.0.1:1/lifecycle-provider")) return originalFetch(input,init);\nawait Bun.write(${JSON.stringify(startedPath)},"started");\nawait Bun.sleep(250);\nreturn Response.json(url.endsWith("/models")?{data:[{id:"local-mock"}]}:{id:"mock",choices:[{message:{role:"assistant",content:"local result"},finish_reason:"stop"}]});\n},originalFetch);\nawait import(${JSON.stringify(serverEntry)});\n`);
    const proc = spawnServer(dir, fixture);
    try {
      const port = await waitForServerReady(proc);
      const base = `http://127.0.0.1:${port}/api`;
      const provider = { id: "finite-sse-provider", type: "openai", name: "Finite SSE local mock", enabled: true, builtIn: false, apiKey: "local-test", baseUrl: "http://127.0.0.1:1/lifecycle-provider", models: [{ id: "finite-sse-model", modelId: "local-mock", type: "CHAT", inputModalities: ["TEXT"], outputModalities: ["TEXT"], abilities: [] }] };
      expect((await fetch(`${base}/settings/provider`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(provider) })).status).toBe(200);
      const stream = await fetch(`${base}/settings/provider/test/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: provider.id, modelId: "local-mock" }) });
      expect(stream.status).toBe(200);
      const body = stream.text();
      await until(() => existsSync(startedPath));
      const started = Date.now();
      expect((await fetch(`${base}/app/shutdown`, { method: "POST" })).status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(await body).toContain("event: done");
      expect(await exited(proc)).toBe(0);
      const settings = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).settings;
      expect(settings.providers.find((item: any) => item.id === provider.id).testPassedAt).toBeGreaterThan(0);
      assertClean(dir);
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a local mock stream is finalized and SQLite reopens after shutdown", async () => {
    const dir = isolatedData();
    let requested = false;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("unexpected mock route", { status: 404 });
      requested = true;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Saved partial response" }, finish_reason: null }] })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
    let proc = spawnServer(dir);
    try {
      const port = await waitForServerReady(proc);
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, body === undefined ? undefined : {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
        return await response.json() as any;
      };
      const settings = await api("settings");
      const model = { id: "lifecycle-model", modelId: "local-mock", displayName: "Local mock", type: "CHAT", inputModalities: ["TEXT"], outputModalities: ["TEXT"], abilities: [], tools: [] };
      await api("settings/provider", { id: "lifecycle-provider", type: "openai", name: "Lifecycle local mock", enabled: true, builtIn: false, apiKey: "local-test", baseUrl: `http://127.0.0.1:${mock.port}`, chatCompletionsPath: "/chat/completions", useResponseApi: false, models: [model] });
      const assistant = settings.assistants.find((item: any) => item.id === settings.assistantId);
      await api("settings/assistant/detail", { ...assistant, chatModelId: model.id, streamOutput: true, enableMemory: false, useGlobalMemory: false, localTools: [], mcpServers: [] });
      await api("settings/default-models", { chatModelId: model.id, titleModelId: model.id, suggestionModelId: "" });
      const id = "lifecycle-conversation";
      await api(`conversations/${id}/messages`, { parts: [{ type: "text", text: "Local lifecycle fixture" }] });
      await until(async () => {
        const conversation = await api(`conversations/${id}`);
        return requested && JSON.stringify(conversation).includes("Saved partial response");
      });
      expect((await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" })).status).toBe(200);
      expect(await exited(proc)).toBe(0);
      assertClean(dir);
      const dbPath = readdirSync(dir).find((name) => name.endsWith(".sqlite") || name.endsWith(".db"));
      expect(dbPath).toBeDefined();
      const db = new Database(join(dir, dbPath!), { readonly: true });
      try { expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { db.close(); }
      proc = spawnServer(dir);
      const restoredPort = await waitForServerReady(proc);
      const restored = await (await fetch(`http://127.0.0.1:${restoredPort}/api/conversations/${id}`)).json() as any;
      expect(JSON.stringify(restored)).toContain("Saved partial response");
      expect(restored.isGenerating).toBe(false);
      const last = restored.messages.at(-1).messages[0];
      expect(last.finishedAt).not.toBeNull();
      expect((await fetch(`http://127.0.0.1:${restoredPort}/api/app/shutdown`, { method: "POST" })).status).toBe(200);
      expect(await exited(proc)).toBe(0);
    } finally {
      proc.kill("SIGKILL");
      mock.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
