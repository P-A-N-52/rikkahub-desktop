// P0/P1 冒烟脚本(保留为回归工具):验证 vendored pi 引擎可被 SDK 内嵌调用,完整闭环:
// 我们的 provider 配置 → model-bridge 映射(P1) → ModelRuntime 内存注册 → inMemory 会话
// → prompt → 事件流 → agent_end。假模型 = 本地 http mock(SSE 格式抄自
// pi/packages/ai/test/openai-completions-thinking-as-text.test.ts)。
// 运行: cd pc-server && bun scripts/pi-spike.ts
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import { model, provider } from "../model-providers";
import { createPiModelRuntime, mapProviderModelToPi } from "../pi-engine/model-bridge";

// 走完整映射链:自定义 UUID provider id(非 pi 内建)实测 registerProvider 注册面。
const SPIKE_PROVIDER_ID = "00000000-0000-4000-8000-000000000001";
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
		// 我们侧配置形状(与 state.json 里的 provider 同构) → 映射 → pi 运行时。
		const ourProvider = provider({
			id: SPIKE_PROVIDER_ID,
			name: "P1 Spike Provider",
			baseUrl: `http://127.0.0.1:${port}`,
			apiKey: "sk-spike-fake",
		});
		const ourModel = model("spike-model", "P1 Spike Fake Model");
		const mapped = mapProviderModelToPi(ourProvider, ourModel);
		if (!mapped.ok) throw new Error(`映射失败: ${mapped.reason}`);
		const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model: piModel,
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
		const requestModel = (requests[0] as { model?: string }).model;
		if (requestModel !== "spike-model") throw new Error(`request model 应为 spike-model,实际 ${requestModel}`);
		console.log("[pi-spike] PASS: 我们的配置 -> 映射 -> 注册 -> prompt -> 事件 -> agent_end 闭环成立");
	} finally {
		server.close();
		await once(server, "close");
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
