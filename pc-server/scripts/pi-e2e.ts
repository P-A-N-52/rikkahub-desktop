// P1 真模型端到端验证脚本(开发用,不进产品路径):
// 读真实 state.json → findModel 同款选择逻辑 → model-bridge 映射 → pi 会话跑一轮真请求。
// 同时实证 project-trust:SDK 无 UI 场景下会话创建与 prompt 全程不得出现任何交互询问。
// 运行: cd pc-server && bun scripts/pi-e2e.ts [modelId或显示名]
// 安全纪律:绝不打印 apiKey;只打印 provider 名称/类型/baseUrl 与模型 id。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import { statePath } from "../foundation/paths";
import type { Model, Provider } from "../foundation/types";
import { createPiModelRuntime, mapProviderModelToPi } from "../pi-engine/model-bridge";

function pickTarget(wanted: string | undefined): { provider: Provider; model: Model } {
	const state = JSON.parse(readFileSync(statePath, "utf-8")) as { settings: { providers: Provider[] } };
	const providers = state.settings.providers.filter((p) => p.enabled);
	if (wanted) {
		// 与 model-providers findModel 同款匹配(id 或 modelId;另放宽显示名方便手工调用)。
		for (const providerItem of providers) {
			const modelItem = providerItem.models.find(
				(m) => m.id === wanted || m.modelId === wanted || m.displayName === wanted,
			);
			if (modelItem) return applyOverwrite(providerItem, modelItem);
		}
		throw new Error(`在启用的 provider 里找不到模型 ${wanted}`);
	}
	for (const providerItem of providers) {
		const modelItem = providerItem.models.find((m) => m.type === "CHAT");
		if (modelItem) return applyOverwrite(providerItem, modelItem);
	}
	throw new Error("没有任何启用的 provider 配有 CHAT 模型");
}

/** providerOverwrite 展开,与 model-providers findModel 逐字同语义。 */
function applyOverwrite(providerItem: Provider, modelItem: Model): { provider: Provider; model: Model } {
	const overwrite = modelItem.providerOverwrite;
	if (overwrite && typeof overwrite === "object" && overwrite.type) {
		return {
			provider: { ...providerItem, ...overwrite, id: providerItem.id, models: [] } as Provider,
			model: modelItem,
		};
	}
	return { provider: providerItem, model: modelItem };
}

async function main(): Promise<void> {
	const { provider, model } = pickTarget(process.argv[2]);
	console.log(`[pi-e2e] provider: ${provider.name} (type=${provider.type}, baseUrl=${provider.baseUrl})`);
	console.log(`[pi-e2e] model: ${model.modelId} (${model.displayName})`);

	const mapped = mapProviderModelToPi(provider, model);
	if (!mapped.ok) throw new Error(`映射失败: ${mapped.reason}`);
	console.log(`[pi-e2e] pi api: ${mapped.mapping.config.api}, baseUrl: ${mapped.mapping.config.baseUrl}`);

	const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);

	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-e2e-"));
	try {
		const started = Date.now();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: join(tmpRoot, "workdir"),
			agentDir: join(tmpRoot, "agent"),
			modelRuntime: runtime,
			model: piModel,
			sessionManager: SessionManager.inMemory(join(tmpRoot, "workdir")),
		});
		if (modelFallbackMessage) console.log(`[pi-e2e] fallback: ${modelFallbackMessage}`);

		const seenEventTypes: string[] = [];
		let assistantText = "";
		let usage: unknown;
		const turnDone = new Promise<void>((resolve) => {
			session.subscribe((event) => {
				seenEventTypes.push(event.type);
				if (event.type === "message_end") {
					const message = (event as { message?: { role?: string; content?: unknown; usage?: unknown; errorMessage?: string } })
						.message;
					if (message?.role === "assistant") {
						usage = message.usage;
						if (message.errorMessage) console.error(`[pi-e2e] 模型错误: ${message.errorMessage}`);
						if (Array.isArray(message.content)) {
							assistantText = message.content
								.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
								.map((c) => c.text)
								.join("");
						}
					}
				}
				if (event.type === "agent_end") resolve();
			});
		});

		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`60s 超时;已见事件: ${seenEventTypes.join(",")}`)), 60_000);
		});
		await Promise.race([Promise.all([session.prompt("请只回答一个数字:1+1=?"), turnDone]), timeout]);

		console.log(`[pi-e2e] events: ${[...new Set(seenEventTypes)].join(", ")}`);
		console.log(`[pi-e2e] assistant: ${JSON.stringify(assistantText)}`);
		console.log(`[pi-e2e] usage: ${JSON.stringify(usage)}`);
		console.log(`[pi-e2e] 用时 ${Date.now() - started}ms`);
		if (!assistantText.trim()) throw new Error("真模型未返回文本");
		console.log("[pi-e2e] PASS: 真模型端到端一轮成立;全程零交互询问(project-trust 无 UI 实证)");
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
