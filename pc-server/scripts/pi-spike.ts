// P0→P2 冒烟脚本(保留为回归工具):验证 vendored pi 引擎经我们的完整 P2 链路可用:
// 我们的 provider 配置 → model-bridge 映射(P1) → runner 驱动会话(P2:jsonl 工作记忆
// + 事件桥) → GenerationEvent → 生产同款应用器写 Message.parts。
// 假模型 = 本地 http mock(test-utils/fake-openai-sse,SSE 格式抄 pi 自家测试)。
// 运行: cd pc-server && bun scripts/pi-spike.ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录沙箱必须在任何业务模块 import 之前钉死(paths.ts 首次 import 即固化)。
const spikeDataDir = mkdtempSync(join(tmpdir(), "pi-spike-data-"));
process.env.RIKKAHUB_PC_DATA_DIR = spikeDataDir;

const { message } = await import("../foundation/utils");
const { model, provider } = await import("../model-providers");
const { createGenerationEventApplier } = await import("../conversations/generation-apply");
const { resolvePiSessionPath } = await import("../pi-engine/session-files");
const { runPiGeneration } = await import("../pi-engine/runner");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

const SPIKE_PROVIDER_ID = "00000000-0000-4000-8000-000000000001";
const FAKE_REPLY = "hello from fake model";

async function main(): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-spike-cwd-"));
	const server = await startFakeOpenAiSse([
		{ content: FAKE_REPLY, usage: { prompt_tokens: 7, completion_tokens: 5 } },
		{ content: "second turn reply", usage: { prompt_tokens: 21, completion_tokens: 4 } },
	]);

	try {
		const ourProvider = provider({
			id: SPIKE_PROVIDER_ID,
			name: "Spike Provider",
			baseUrl: server.baseUrl,
			apiKey: "sk-spike-fake",
		});
		const ourModel = model("fake-model", "Spike Fake Model");

		// 我们会话模型里的一轮生成目标(生产由 generateAnswer 构造,冒烟自构同形)。
		const assistantMessage = message("ASSISTANT", [], ourModel.id);
		assistantMessage.parts = [{ type: "loading", label: "正在生成回复" }];
		const node = { id: "spike-node", messages: [assistantMessage], selectIndex: 0 };
		const conversation = {
			id: "spike-conv",
			assistantId: "spike-assistant",
			systemPrompt: null,
			title: "",
			messages: [node],
			chatSuggestions: [],
			isPinned: false,
			createAt: Date.now(),
			updateAt: Date.now(),
		};
		const apply = createGenerationEventApplier({ conversation, node, message: assistantMessage });

		const first = await runPiGeneration({
			provider: ourProvider,
			model: ourModel,
			conversationId: conversation.id,
			cwd,
			promptText: "Say hello",
			sink: apply,
		});
		console.log("[pi-spike] turn1 text:", JSON.stringify(first.text), "resumed:", first.resumed);
		console.log("[pi-spike] turn1 parts:", JSON.stringify(assistantMessage.parts));
		console.log("[pi-spike] turn1 usage:", JSON.stringify(assistantMessage.usage));

		if (first.text !== FAKE_REPLY) throw new Error("turn1 文本未闭环");
		if (first.resumed) throw new Error("turn1 不应是续会话");
		if (!existsSync(resolvePiSessionPath(first.sessionFileName))) throw new Error("jsonl 工作记忆未落盘");
		const textPart = assistantMessage.parts.find((part) => part.type === "text");
		if (!textPart || (textPart as { text?: string }).text !== FAKE_REPLY) throw new Error("part 序列未写入正文");
		if (assistantMessage.parts.some((part) => part.type === "loading")) throw new Error("loading 占位未被剥离");
		if (!assistantMessage.usage) throw new Error("usage 未合并");

		// 第二轮:续会话,历史必须回放给上游(引擎工作记忆的硬证据)。
		const second = await runPiGeneration({
			provider: ourProvider,
			model: ourModel,
			conversationId: conversation.id,
			storedSessionFileName: first.sessionFileName,
			cwd,
			promptText: "And again",
			sink: apply,
		});
		console.log("[pi-spike] turn2 text:", JSON.stringify(second.text), "resumed:", second.resumed);
		if (!second.resumed) throw new Error("turn2 应为续会话");
		const secondRequest = server.requests[1] as { messages?: unknown[] };
		const replay = JSON.stringify(secondRequest?.messages ?? []);
		if (!replay.includes(FAKE_REPLY) || !replay.includes("Say hello")) {
			throw new Error("turn2 上游请求未携带第一轮上下文");
		}

		console.log("[pi-spike] PASS: 配置→映射→runner(jsonl)→事件桥→应用器→parts 全链路闭环 + 续会话上下文回放");
	} finally {
		await server.close();
		rmSync(spikeDataDir, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
