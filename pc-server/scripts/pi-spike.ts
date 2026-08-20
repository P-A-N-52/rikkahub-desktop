// P0 冒烟脚本:验证 vendored pi 引擎可被 SDK 内嵌调用,完整闭环:
// 依赖解析 → ModelRuntime 注入 → inMemory 会话 → prompt → 事件流 → agent_end。
// 假模型 = 本地 http mock(SSE 格式抄自 pi/packages/ai/test/openai-completions-thinking-as-text.test.ts)。
// 运行: cd pc-server && bun scripts/pi-spike.ts
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model } from "../../pi/packages/ai/src/types.ts";
import { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";

// 借内建 "deepseek" 作 provider id:pi-ai Models 注册表只认已注册 provider(自定义 id 需经
// ModelConfig 注册,那是 P1 的正题),且 provider 注册决定流式客户端("openai" 会路由到
// Responses API)。deepseek 注册为 openai-completions + api-key 鉴权,正合本 mock。
const FAKE_PROVIDER = "deepseek";
const FAKE_REPLY = "hello from fake model";

function startFakeOpenAiServer(): Promise<{ server: http.Server; port: number; requests: unknown[] }> {
	const requests: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			console.log("[pi-spike] fake llm unexpected request:", req.method, req.url);
			res.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		requests.push(JSON.parse(body));

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		chunk({
			id: "chatcmpl-spike",
			object: "chat.completion.chunk",
			created: 0,
			model: "spike-model",
			choices: [{ index: 0, delta: { role: "assistant", content: FAKE_REPLY }, finish_reason: null }],
		});
		chunk({
			id: "chatcmpl-spike",
			object: "chat.completion.chunk",
			created: 0,
			model: "spike-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 7, completion_tokens: 5 },
		});
		res.write("data: [DONE]\n\n");
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as AddressInfo).port, requests });
		});
	});
}

async function main(): Promise<void> {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-spike-"));
	const cwd = join(tmpRoot, "workdir");
	const agentDir = join(tmpRoot, "agent");
	const { server, port, requests } = await startFakeOpenAiServer();

	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(tmpRoot, "auth.json"),
			modelsPath: null,
		});
		await modelRuntime.setRuntimeApiKey(FAKE_PROVIDER, "fake-key");

		const model: Model<"openai-completions"> = {
			id: "spike-model",
			name: "P0 Spike Fake Model",
			api: "openai-completions",
			provider: FAKE_PROVIDER,
			baseUrl: `http://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			sessionManager: SessionManager.inMemory(cwd),
		});

		const seenEventTypes: string[] = [];
		let assistantText = "";
		const turnDone = new Promise<void>((resolve) => {
			session.subscribe((event) => {
				seenEventTypes.push(event.type);
				if (event.type === "message_update") {
					const message = (event as { message?: { role?: string; content?: unknown } }).message;
					if (message?.role === "assistant" && Array.isArray(message.content)) {
						assistantText = message.content
							.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
							.map((c) => c.text)
							.join("");
					}
				}
				if (event.type === "agent_end") resolve();
			});
		});

		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`timed out; events so far: ${seenEventTypes.join(",")}`)), 30_000);
		});
		await Promise.race([Promise.all([session.prompt("Say hello"), turnDone]), timeout]);

		const uniqueEvents = [...new Set(seenEventTypes)];
		console.log("[pi-spike] events:", uniqueEvents.join(", "));
		console.log("[pi-spike] assistant text:", JSON.stringify(assistantText));
		console.log("[pi-spike] llm requests received:", requests.length);

		if (requests.length !== 1) throw new Error("fake llm expected exactly 1 request");
		if (!assistantText.includes(FAKE_REPLY)) throw new Error("assistant text did not round-trip");
		console.log("[pi-spike] PASS: prompt -> events -> agent_end 闭环成立");
	} finally {
		server.close();
		await once(server, "close");
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
