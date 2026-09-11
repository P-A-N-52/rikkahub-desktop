// media/tts.ts — 文本转语音（system/openai/gemini 等 Provider、SSE 音频收集、PCM→WAV）
// 纪律：负责 TTS Provider 默认值/归一化与语音合成实现，不处理路由。
// 请求日志暂经 ../server 的 addLog 记录（3.5 拆 api/ 时收敛）。

import type { JsonValue, TtsProvider } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { id, isRecord, mergeById } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { jsonBody, textBody } from "../model-providers";
import { synthesizeSystemTtsToWav, systemTtsBackend } from "../tools";
import { addLog } from "../api/logs";

export const DEFAULT_SYSTEM_TTS_ID = "026a01a2-c3a0-4fd5-8075-80e03bdef200";

export function defaultTtsProvider(type: TtsProvider["type"] = "system"): TtsProvider {
  if (type === "openai") {
    return {
      type,
      id: id(),
      name: "OpenAI TTS",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };
  }
  if (type === "gemini") {
    return {
      type,
      id: id(),
      name: "Gemini TTS",
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    };
  }
  if (type === "minimax") {
    return {
      type,
      id: id(),
      name: "MiniMax TTS",
      apiKey: "",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.6-turbo",
      voiceId: "female-shaonv",
      // Empty string == "自动" in the UI dropdown == omit the `emotion` field entirely from
      // the request body so MiniMax picks an emotion based on the text. Switching the default
      // from "calm" to auto matches Android's default behavior on the Kotlin side.
      emotion: "",
      speed: 1,
    };
  }
  if (type === "qwen") {
    return {
      type,
      id: id(),
      name: "Qwen TTS",
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      languageType: "Auto",
    };
  }
  if (type === "groq") {
    return {
      type,
      id: id(),
      name: "Groq TTS",
      apiKey: "",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    };
  }
  if (type === "xai") {
    return {
      type,
      id: id(),
      name: "xAI TTS",
      apiKey: "",
      baseUrl: "https://api.x.ai/v1",
      voiceId: "eve",
      language: "auto",
    };
  }
  if (type === "mimo") {
    return {
      type,
      id: id(),
      name: "MiMo TTS",
      apiKey: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-tts",
      voice: "mimo_default",
    };
  }
  return {
    type: "system",
    id: DEFAULT_SYSTEM_TTS_ID,
    name: "System TTS",
    apiKey: "",
    baseUrl: "",
    speechRate: 1,
    pitch: 1,
  };
}

export function defaultTtsProviders(): TtsProvider[] {
  return [
    defaultTtsProvider("system"),
  ];
}

export function normalizeTtsProviders(value: unknown): TtsProvider[] {
  const defaults = defaultTtsProviders();
  const raw = Array.isArray(value) ? value.filter(isRecord) : [];
  const normalized = raw.map((item) => {
    const type = ["system", "openai", "gemini", "minimax", "qwen", "groq", "xai", "mimo"].includes(String(item.type))
      ? String(item.type) as TtsProvider["type"]
      : "system";
    const base = defaultTtsProvider(type);
    return {
      ...base,
      ...item,
      type,
      id: String(item.id ?? base.id),
      name: String(item.name ?? base.name),
      apiKey: String(item.apiKey ?? ""),
      baseUrl: String(item.baseUrl ?? base.baseUrl),
    };
  });
  return mergeById(normalized, defaults);
}

function selectedTtsProvider(providerId?: string) {
  return state.settings.ttsProviders.find((provider) => provider.id === providerId)
    ?? state.settings.ttsProviders.find((provider) => provider.id === state.settings.selectedTTSProviderId)
    ?? state.settings.ttsProviders[0]
    ?? null;
}

function ttsMimeForProvider(provider: TtsProvider) {
  if (provider.type === "groq" || provider.type === "gemini" || provider.type === "qwen" || provider.type === "mimo") return "audio/wav";
  return "audio/mpeg";
}

function pcm16ToWav(pcm: Buffer, sampleRate = 24000, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeHexBytes(hexString: string) {
  const clean = hexString.replace(/\s+/g, "");
  if (!clean || clean.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(clean, "hex");
}

async function collectSseAudio(
  response: Response,
  parseData: (data: string) => Buffer | null,
) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  let buffer = "";
  let currentData = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          currentData += line.slice(5).trim();
        } else if (line.trim() === "" && currentData) {
          const audio = parseData(currentData);
          if (audio?.length) chunks.push(audio);
          currentData = "";
        }
      }
    }
    if (done) break;
  }
  if (currentData) {
    const audio = parseData(currentData);
    if (audio?.length) chunks.push(audio);
  }
  return Buffer.concat(chunks);
}

export async function generateSpeechWithTtsProvider(text: string, providerId?: string, speedOverride?: number) {
  const provider = selectedTtsProvider(providerId);
  if (!provider) throw new Error("No TTS provider configured");
  const started = Date.now();
  if (provider.type === "system") {
    const speed = Number.isFinite(speedOverride) && (speedOverride as number) > 0
      ? (speedOverride as number)
      : Number(provider.speechRate ?? 1);
    const wavBytes = await synthesizeSystemTtsToWav(text, speed, provider.voice);
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: systemTtsBackend(),
      ok: true,
      status: 200,
      kind: "provider:tts",
      durationMs: Date.now() - started,
      requestBody: text,
      responseBody: `${wavBytes.length} bytes audio/wav`,
    });
    return { audio: wavBytes, mime: "audio/wav", provider };
  }
  if (!provider.apiKey.trim()) throw new Error("TTS API Key is empty");
  let endpoint = "";
  let body: Record<string, JsonValue> = {};
  let mime = ttsMimeForProvider(provider);
  let headers: Record<string, string> = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" };
  let parseAudio: ((response: Response) => Promise<Buffer>) | null = null;
  if (provider.type === "openai" || provider.type === "groq") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    body = {
      model: provider.model || (provider.type === "openai" ? "gpt-4o-mini-tts" : "canopylabs/orpheus-v1-english"),
      input: text,
      voice: provider.voice || (provider.type === "openai" ? "alloy" : "austin"),
      response_format: provider.type === "groq" ? "wav" : "mp3",
    };
    parseAudio = async (response) => Buffer.from(await response.arrayBuffer());
  } else if (provider.type === "gemini") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models/${provider.model || "gemini-2.5-flash-preview-tts"}:generateContent`;
    headers = { "x-goog-api-key": provider.apiKey, "Content-Type": "application/json" };
    body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: provider.voiceName || "Kore" } } },
      },
      model: provider.model || "gemini-2.5-flash-preview-tts",
    };
    parseAudio = async (response) => {
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
      const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
      const first = candidates[0] as Record<string, unknown> | undefined;
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const part = parts[0] as Record<string, unknown> | undefined;
      const inlineData = part?.inlineData as Record<string, unknown> | undefined;
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (!data) throw new Error("No audio data returned from Gemini TTS");
      return pcm16ToWav(Buffer.from(data, "base64"), 24000, 1);
    };
  } else if (provider.type === "minimax") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/t2a_v2`;
    // MiniMax's `emotion` is a soft-optional field: when omitted entirely from the request,
    // MiniMax auto-selects an emotion based on the text content. The UI exposes this as the
    // "自动" option (stored as empty string). We must NOT send `emotion: ""` — that's
    // rejected — we have to drop the field entirely. Hence the conditional spread.
    const voiceSetting: Record<string, JsonValue> = {
      voice_id: provider.voiceId || "female-shaonv",
      speed: Number(provider.speed ?? 1),
    };
    if (provider.emotion) voiceSetting.emotion = provider.emotion;
    body = {
      model: provider.model || "speech-2.6-turbo",
      text,
      stream: true,
      output_format: "hex",
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: voiceSetting,
    };
    parseAudio = async (response) => collectSseAudio(response, (data) => {
      if (data === "[DONE]") return null;
      const raw = JSON.parse(data || "{}") as { data?: { audio?: string } };
      return decodeHexBytes(raw.data?.audio ?? "");
    });
  } else if (provider.type === "qwen") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/services/aigc/multimodal-generation/generation`;
    headers = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", "X-DashScope-SSE": "enable" };
    body = {
      model: provider.model || "qwen3-tts-flash",
      input: { text, voice: provider.voice || "Cherry", language_type: provider.languageType || "Auto" },
    };
    parseAudio = async (response) => {
      const pcm = await collectSseAudio(response, (data) => {
        const raw = JSON.parse(data || "{}") as { output?: { audio?: { data?: string } } };
        const encoded = raw.output?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      return pcm16ToWav(pcm, 24000, 1);
    };
  } else if (provider.type === "xai") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/tts`;
    body = {
      text,
      voice_id: provider.voiceId || "eve",
      language: provider.language || "auto",
    };
    parseAudio = async (response) => Buffer.from(await response.arrayBuffer());
  } else if (provider.type === "mimo") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    headers = { "api-key": provider.apiKey, "Content-Type": "application/json" };
    body = {
      model: provider.model || "mimo-v2-tts",
      messages: [{ role: "assistant", content: text }],
      audio: { format: "pcm16", voice: provider.voice || "mimo_default" },
      stream: true,
    };
    parseAudio = async (response) => {
      const pcm = await collectSseAudio(response, (data) => {
        if (data === "[DONE]") return null;
        const raw = JSON.parse(data || "{}") as { choices?: Array<{ delta?: { audio?: { data?: string } } }> };
        const encoded = raw.choices?.[0]?.delta?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      return pcm16ToWav(pcm, 24000, 1);
    };
  }
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: 120_000, // 长文本合成分钟级,30s 默认会误杀
  });
  const audio = response.ok && parseAudio
    ? await parseAudio(response)
    : Buffer.from(await response.arrayBuffer());
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:tts",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: response.ok ? `${audio.length} bytes ${mime}` : textBody(audio.toString("utf8")),
    error: response.ok ? undefined : textBody(audio.toString("utf8")),
  });
  if (!response.ok) throw new Error(`TTS request failed: ${response.status} ${audio.toString("utf8").slice(0, 500)}`);
  return { audio, mime, provider };
}
