// 验证三处修复:正常迁移 / 方案A(迁移失败保留 state.json)/ 方案B(.bak 兜底)/ 发现2(活库损坏降级)
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const convs = [
  { id: "c1", assistantId: "a1", title: "Conv 1", systemPrompt: "sp1", messages: [{ id: "n1", messages: [{ id: "m1", role: "USER", parts: [{ type: "text", text: "hello 1" }] }], selectIndex: 0 }], truncateIndex: 3, chatSuggestions: ["s1"], isPinned: false, createAt: 1000, updateAt: 1000 },
  { id: "c2", assistantId: "a1", title: "Conv 2", systemPrompt: null, messages: [{ id: "n2", messages: [{ id: "m2", role: "ASSISTANT", parts: [{ type: "text", text: "hello 2" }] }], selectIndex: 0 }], truncateIndex: -1, chatSuggestions: [], isPinned: true, createAt: 2000, updateAt: 2000 },
];
const baseSettings = { providers: [{ id: "p1", name: "Test", apiKey: "k", type: "openai", enabled: true, models: [{ id: "m1", name: "M", modelId: "m1" }] }], assistants: [{ id: "a1", name: "A" }], assistantId: "a1", chatModelId: "m1" };

function mkState(extra: Record<string, unknown> = {}) {
  return { settings: baseSettings, files: [] as unknown[], generatedImages: [] as unknown[], memories: [] as unknown[], nextFileId: 1, nextMemoryId: 1, nextGeneratedImageId: 1, launchCount: 5, ...extra };
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
}

async function boot(tempDir: string, port: number) {
  const baseUrl = `http://localhost:${port}`;
  const proc = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RIKKAHUB_PC_DATA_DIR: tempDir, BROWSER: "none", RIKKAHUB_ANALYTICS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const dec = new TextDecoder();
  const err: string[] = [];
  // 显式 reader 而非 `for await...of proc.stderr`:pi 0.84.2 带入的 undici-types 全局
  // ReadableStream 遮蔽了 lib.dom.iterable 的可迭代声明,类型层丢失 Symbol.asyncIterator。
  (async () => {
    const reader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) err.push(dec.decode(value));
    }
  })();
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${baseUrl}/api/health`); if (r.ok) { healthy = true; break; } } catch {}
    await Bun.sleep(250);
  }
  return { healthy, proc, baseUrl, stderr: () => err.join("") };
}

async function shutdown(proc: any) {
  try { proc.kill("SIGTERM"); } catch {}
  await Bun.sleep(800);
}

async function getConvs(baseUrl: string) {
  const r = await fetch(`${baseUrl}/api/conversations`);
  return await r.json();
}

// ============ 场景 1:正常迁移(回归)============
console.log("\n=== 场景 1:正常迁移(回归)===");
{
  const tempDir = mkdtempSync(join(tmpdir(), "v1-normal-"));
  writeFileSync(join(tempDir, "state.json"), JSON.stringify(mkState({ conversations: convs })));
  const port = 20001 + Math.floor(Math.random() * 500);
  const { healthy, proc, baseUrl } = await boot(tempDir, port);
  check("服务启动", healthy);
  if (healthy) {
    const data = await getConvs(baseUrl);
    check("API 返回 2 条会话", Array.isArray(data) && data.length === 2, `got ${JSON.stringify(data).slice(0, 100)}`);
    const detail = await (await fetch(`${baseUrl}/api/conversations/c1`)).json();
    check("systemPrompt 保留", detail.systemPrompt === "sp1", `got ${detail.systemPrompt}`);
    // 1.5.0 跟进安卓 Migration_16_17:truncateIndex 机制废弃。老 state.json 的该字段
    // (种子数据保留以模拟老格式)迁移时被丢弃,活库列被 DROP,API 不再返回。
    check("truncateIndex 已移除(安卓对齐)", !("truncateIndex" in detail), `got ${detail.truncateIndex}`);
    const s = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
    check("state.json 已瘦身(无 conversations)", !Array.isArray(s.conversations));
    check("迁移标记已写", Array.isArray(s.appliedMigrations) && s.appliedMigrations.includes("conversations-sqlite-1.2.6"));
    check(".bak 已生成", existsSync(join(tempDir, "state.json.pre-sqlite.bak")));
    await shutdown(proc);
  }
  rmSync(tempDir, { recursive: true, force: true });
}

// ============ 场景 2:方案 A——迁移失败时 state.json 保留 conversations ============
console.log("\n=== 场景 2:方案 A(迁移失败,state.json 保全)===");
{
  const tempDir = mkdtempSync(join(tmpdir(), "v2-failA-"));
  writeFileSync(join(tempDir, "state.json"), JSON.stringify(mkState({ conversations: convs })));
  // 预建活库,pc_conversation 表加 CHECK 约束让 INSERT 数字 create_at 时抛错 → 迁移事务失败
  const seed = new Database(join(tempDir, "rikka_hub.db"), { create: true, readwrite: true });
  seed.exec("CREATE TABLE pc_conversation (id TEXT PRIMARY KEY NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', truncate_index INTEGER NOT NULL DEFAULT -1, suggestions TEXT NOT NULL DEFAULT '[]', is_pinned INTEGER NOT NULL DEFAULT 0, create_at INTEGER NOT NULL CHECK(typeof(create_at)='text'), update_at INTEGER NOT NULL)");
  seed.exec("CREATE TABLE pc_message_node (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, node_index INTEGER NOT NULL, messages TEXT NOT NULL DEFAULT '[]', select_index INTEGER NOT NULL DEFAULT 0)");
  seed.close();

  const port = 20501 + Math.floor(Math.random() * 500);
  const { healthy, proc, baseUrl, stderr } = await boot(tempDir, port);
  check("服务启动(迁移失败不崩溃)", healthy);
  if (healthy) {
    const s = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
    check("方案 A:state.json 仍含 conversations(2 条)", Array.isArray(s.conversations) && s.conversations.length === 2, `got ${Array.isArray(s.conversations) ? s.conversations.length : "N/A"}`);
    check("方案 A:迁移标记未写(待重试)", !(Array.isArray(s.appliedMigrations) && s.appliedMigrations.includes("conversations-sqlite-1.2.6")));
    const data = await getConvs(baseUrl);
    check("方案 A:当次会话内存可见", Array.isArray(data) && data.length === 2, `got ${data && data.length}`);
    await shutdown(proc);

    // 二次启动:删掉约束库,迁移应成功
    rmSync(join(tempDir, "rikka_hub.db"), { force: true });
    rmSync(join(tempDir, "rikka_hub.db-wal"), { force: true });
    rmSync(join(tempDir, "rikka_hub.db-shm"), { force: true });
    const port2 = port + 1;
    const r2 = await boot(tempDir, port2);
    check("方案 A:二次启动成功(重试迁移)", r2.healthy);
    if (r2.healthy) {
      const data2 = await getConvs(r2.baseUrl);
      check("方案 A:重试后会话恢复(2 条)", Array.isArray(data2) && data2.length === 2, `got ${data2 && data2.length}`);
      const s2 = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
      check("方案 A:重试后迁移标记写入", Array.isArray(s2.appliedMigrations) && s2.appliedMigrations.includes("conversations-sqlite-1.2.6"));
      await shutdown(r2.proc);
    }
  } else {
    console.log("  stderr:", stderr().slice(-500));
  }
  rmSync(tempDir, { recursive: true, force: true });
}

// ============ 场景 3:方案 B——state.json 被抹空 + .bak 有数据 ============
console.log("\n=== 场景 3:方案 B(.bak 兜底恢复)===");
{
  const tempDir = mkdtempSync(join(tmpdir(), "v3-failB-"));
  writeFileSync(join(tempDir, "state.json"), JSON.stringify(mkState({})));
  writeFileSync(join(tempDir, "state.json.pre-sqlite.bak"), JSON.stringify(mkState({ conversations: convs })));
  const port = 21001 + Math.floor(Math.random() * 500);
  const { healthy, proc, baseUrl, stderr } = await boot(tempDir, port);
  check("服务启动", healthy);
  if (healthy) {
    const data = await getConvs(baseUrl);
    check("方案 B:从 .bak 恢复 2 条会话", Array.isArray(data) && data.length === 2, `got ${data && data.length}`);
    const s = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
    check("方案 B:迁移标记已写(恢复后落定)", Array.isArray(s.appliedMigrations) && s.appliedMigrations.includes("conversations-sqlite-1.2.6"));
    await shutdown(proc);
  } else {
    console.log("  stderr:", stderr().slice(-500));
  }
  rmSync(tempDir, { recursive: true, force: true });
}

// ============ 场景 4:发现 2——活库损坏降级(未迁移过,从 state.json 重灌)============
console.log("\n=== 场景 4:发现 2(活库损坏,降级重建+重灌)===");
{
  const tempDir = mkdtempSync(join(tmpdir(), "v4-corrupt-"));
  writeFileSync(join(tempDir, "state.json"), JSON.stringify(mkState({ conversations: convs })));
  writeFileSync(join(tempDir, "rikka_hub.db"), Buffer.from("NOT_A_VALID_SQLITE_FILE_CORRUPT_GARBAGE"));
  const port = 21501 + Math.floor(Math.random() * 500);
  const { healthy, proc, baseUrl, stderr } = await boot(tempDir, port);
  check("发现 2:活库损坏服务仍启动", healthy);
  if (healthy) {
    const data = await getConvs(baseUrl);
    check("发现 2:从 state.json 重灌后 2 条会话", Array.isArray(data) && data.length === 2, `got ${data && data.length}`);
    const corruptFiles = readdirSync(tempDir).filter(f => f.startsWith("rikka_hub.db.corrupt-"));
    check("发现 2:坏文件已隔离保留", corruptFiles.length === 1, `got ${JSON.stringify(corruptFiles)}`);
    await shutdown(proc);
  } else {
    console.log("  stderr:", stderr().slice(-500));
  }
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n=== 结果:${pass} 通过, ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
